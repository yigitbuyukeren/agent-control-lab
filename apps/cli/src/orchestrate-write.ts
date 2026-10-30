import { relative } from 'node:path';
import {
  DEFAULT_LIMITS,
  DEFAULT_REQUEST,
  MANAGED_POLICY_LIMIT,
  MAX_HANDOFF_CHARS,
  createWorkspaceInspector,
  executeWorkflow,
  planImplementReviewSteps,
  prepareWorkspace,
  runVerify,
  validateWorkingDir,
  type GitReadDeps,
  type PrepareResult,
} from '@agent-control-lab/core';
import { CLAUDE_REFUSALS, REFUSALS, describeIssue } from './format.ts';
import { claudePreflight, codexPreflight } from './preflight.ts';
import { claudeDetails, formatResult, formatStep, type OrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from './orchestrate.ts';

/** Fixed explanations for why a workspace was rejected; nothing here comes from git output. */
const WORKSPACE_PROBLEMS: Record<string, string> = {
  'not-a-linked-worktree': 'the workspace is not a linked Git worktree (the main working tree is never written to); create one yourself with `git worktree add`',
  'detached-head': 'the workspace has a detached HEAD; check out a branch of its own first',
  'protected-branch': 'the workspace is on a protected branch or the main worktree\'s branch; use a branch of its own',
  'workspace-dirty': 'the workspace has uncommitted or untracked changes; commit or stash them first so every change can be attributed',
};

const WORKSPACE_UNREADABLE = 'the workspace Git state could not be read (not a repository, git missing, or an unexpected answer)';

function workspaceVerdict(prep: PrepareResult): string {
  if (prep.ok) return 'ok';
  if (prep.reason === 'git-state-unreadable') return `rejected: ${WORKSPACE_UNREADABLE}`;
  return `rejected: ${prep.problems.join(', ')}`;
}

/**
 * `plan-implement-review`: Claude plans, Codex implements in an existing, isolated worktree,
 * a local step checks the result against the change limits, an optional verification command
 * runs, and Claude reviews the diff. Nothing is created, committed, pushed, reverted or deleted.
 */
export async function runPlanImplementReviewCommand(args: OrchestrateArgs, io: OrchestrateIo, deps: OrchestrateDeps): Promise<number> {
  const cwd = await validateWorkingDir(args.workspace ?? '');
  if (cwd === undefined) {
    io.error('orchestrate refused: the workspace directory does not exist\n');
    return 1;
  }
  const gitDeps: GitReadDeps = {
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };
  const prep = await prepareWorkspace(cwd, gitDeps);
  // The write target must be the worktree root itself, not a folder inside it.
  const atRoot = prep.ok ? relative(prep.before.root, cwd) === '' : prep.reason === 'workspace-rejected' && relative(prep.snapshot.root, cwd) === '';
  const input = { task: args.task, request: DEFAULT_REQUEST, acceptUnverified: args.acceptUnverified, cwd };
  const claude = await claudePreflight(input, deps);
  const codex = await codexPreflight(input, deps);
  const ready = prep.ok && atRoot && claude.plan.ok && codex.plan.ok;
  const total = args.verify === undefined ? 4 : 5;
  const n = (i: number) => `step ${String(i)}/${String(total)}`;
  const claudeVerdict = claude.plan.ok ? 'would run' : `would refuse: ${CLAUDE_REFUSALS[claude.plan.reason]}`;
  const codexVerdict = codex.plan.ok ? 'would run' : `would refuse: ${REFUSALS[codex.plan.reason]}`;
  const snapshot = prep.ok ? prep.before : prep.reason === 'workspace-rejected' ? prep.snapshot : undefined;
  const codexIssues = codex.plan.ok ? '' : codex.plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`).join('');

  if (args.dryRun) {
    const limits = DEFAULT_LIMITS;
    io.out(
      'orchestrate plan (dry run, no agent started)\n' +
        `  workflow: ${args.workflow}\n  workspace: ${cwd}\n` +
        (snapshot === undefined
          ? ''
          : `  branch: ${snapshot.branch ?? 'detached'} (head ${snapshot.head.slice(0, 8)}); main worktree: ${snapshot.mainRoot ?? 'unknown'} on ${snapshot.mainBranch ?? 'no branch'}\n`) +
        `  workspace check: ${atRoot || !prep.ok ? workspaceVerdict(prep) : 'rejected: the workspace must be the worktree root'}\n` +
        (prep.ok || prep.reason === 'git-state-unreadable' ? '' : prep.problems.map((p) => `      ${WORKSPACE_PROBLEMS[p] ?? p}\n`).join('')) +
        `  timeout: ${String(args.timeoutMs / 1000)}s per step\n  task: ${String(args.task.length)} characters\n` +
        `  ${n(1)} plan [claude]: tool-less, no session persistence, subscription login: ${claudeVerdict}\n` +
        claudeDetails(claude) +
        `  ${n(2)} implement [codex]: WRITE sandbox limited to the workspace, git ${codex.git}, subscription login: ${codexVerdict}\n` +
        codexIssues +
        `  ${n(3)} inspect [local]: read-only Git comparison with the state above, always runs, even after a failure or cancel\n` +
        `      limits: ${String(limits.maxFiles)} files, ${String(limits.maxChangedLines)} changed lines, ${String(limits.maxNewFileBytes)} bytes per new file; no binary files, symlinks, commits, branch changes or protected paths (.git, .github/workflows, .claude, .env*, ...)\n` +
        (args.verify === undefined
          ? ''
          : `  ${n(4)} verify [local]: ${[args.verify.command, ...args.verify.args].join(' ')} (no shell, cleaned environment; runs the newly written code outside any model sandbox)\n`) +
        `  ${n(total)} review [claude]: tool-less; sees the plan, the change report with the diff, and the verification result as untrusted data (at most ${String(MAX_HANDOFF_CHARS)} characters each)\n` +
        '  guarantees: no commit, no push, no branch or main-tree changes, no workspace creation, no revert or delete, no retries, no provider fallback, no API keys\n' +
        '  on failure or cancel: the workspace keeps whatever was written; the final state is reported and nothing is rolled back\n' +
        `  managed policy: ${MANAGED_POLICY_LIMIT}\n` +
        '  requires: --confirm-write' +
        `${claude.selection.issues.length + codex.selection.issues.length > 0 ? ', --accept-unverified' : ''}\n` +
        `  verdict: ${ready ? 'would run' : 'would refuse'}\n`,
    );
    return ready ? 0 : 1;
  }

  if (!ready) {
    io.error(
      'orchestrate refused: no step was started and nothing was written\n' +
        (prep.ok
          ? atRoot
            ? ''
            : '  workspace: it must be the root of the worktree\n'
          : prep.reason === 'git-state-unreadable'
            ? `  workspace: ${WORKSPACE_UNREADABLE}\n`
            : prep.problems.map((p) => `  workspace: ${WORKSPACE_PROBLEMS[p] ?? p}\n`).join('')) +
        (claude.plan.ok ? '' : `  step plan [claude]: ${CLAUDE_REFUSALS[claude.plan.reason]}\n${claudeDetails(claude)}`) +
        (codex.plan.ok ? '' : `  step implement [codex]: ${REFUSALS[codex.plan.reason]}\n${codexIssues}`),
    );
    return 1;
  }
  io.error(
    `orchestrating ${args.workflow}: Codex may WRITE files in ${cwd} (branch ${prep.before.branch ?? ''}); no commit, no push, no retries, no fallback\n` +
      [...claude.plan.warnings, ...codex.plan.warnings].map((i) => `  warning: ${describeIssue(i)}\n`).join(''),
  );
  const verifyCommand = args.verify;
  const steps = planImplementReviewSteps({
    task: args.task,
    cwd,
    claudeSelection: claude.selection,
    codexSelection: codex.selection,
    timeoutMs: args.timeoutMs,
    inspect: createWorkspaceInspector({ cwd, before: prep.before, git: gitDeps }),
    ...(verifyCommand === undefined
      ? {}
      : {
          verify: (signal: AbortSignal | undefined) =>
            runVerify(
              { command: verifyCommand, cwd, timeoutMs: args.timeoutMs, ...(signal === undefined ? {} : { signal }) },
              { ...(deps.runner === undefined ? {} : { runner: deps.runner }), ...(deps.env === undefined ? {} : { env: deps.env }) },
            ),
        }),
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });
  const result = await executeWorkflow(args.workflow, steps, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    onUpdate: (step, index, count) => {
      if (step.status === 'running') io.error(`${formatStep(step, index, count)}\n`);
      else io.error(`${formatStep(step, index, count)}${step.error === undefined ? '' : `: ${step.error}`}\n`);
    },
  });
  io.out(formatResult(result));
  const wrote = result.steps.some((s) => s.id === 'implement' && s.status !== 'skipped' && s.status !== 'pending');
  const partial = wrote && result.status !== 'completed' ? 'The workspace may contain partial changes; nothing was reverted. ' : '';
  io.out(
    partial +
      `Nothing was committed or pushed. Review the changes yourself: git -C "${cwd}" status && git -C "${cwd}" diff\n`,
  );
  return result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
}
