import { randomUUID } from 'node:crypto';
import { applyInstructionContext } from './instruction-pass.ts';
import { beginTask, recordTask } from './task-recorder.ts';
import { relative } from 'node:path';
import {
  DEFAULT_LIMITS,
  MANAGED_POLICY_LIMIT,
  MAX_HANDOFF_CHARS,
  createVerificationGuard,
  createWorkspaceInspector,
  executeWorkflow,
  planImplementReviewSteps,
  prepareWorkspace,
  resolveSandbox,
  runVerify,
  validateWorkingDir,
  type GitReadDeps,
  type PrepareResult,
} from '@agent-control-lab/core';
import { recordRun } from './outcome-recorder.ts';
import { applyPolicy } from './policy.ts';
import { formatResult, formatStep, policyLine, readOnlyMode, type OrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from './orchestrate.ts';
import { preflightSteps, selectionLines, stepDetails, stepOk, stepSelection, stepVerdict, stepWarnings } from './step-preflight.ts';

/** Fixed explanations for why a workspace was rejected; nothing here comes from git output. */
const WORKSPACE_PROBLEMS: Record<string, string> = {
  'not-a-linked-worktree': 'the workspace is not a linked Git worktree (the main working tree is never written to); create one yourself with `git worktree add`',
  'detached-head': 'the workspace has a detached HEAD; check out a branch of its own first',
  'protected-branch': 'the workspace is on a protected branch or the main worktree\'s branch; use a branch of its own',
  'workspace-dirty': 'the workspace has uncommitted or untracked changes; commit or stash them first so every change can be attributed',
  'ignored-coverage-partial': 'the workspace has ignored directories too large to compare in full (such as node_modules); changes inside them would only be seen one level deep. Use a worktree without them, or accept that limit with --allow-partial-ignored-check',
};

const WORKSPACE_UNREADABLE = 'the workspace Git state could not be read (not a repository, git missing, or an unexpected answer)';

function workspaceVerdict(prep: PrepareResult): string {
  if (prep.ok) return 'ok';
  if (prep.reason === 'git-state-unreadable') return `rejected: ${WORKSPACE_UNREADABLE}`;
  return `rejected: ${prep.problems.join(', ')}`;
}

/**
 * `plan-implement-review`: any provider plans, implements (Claude or Codex, default Codex) in an existing, isolated worktree,
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
  const prep = await prepareWorkspace(cwd, gitDeps, { allowPartialIgnored: args.allowPartialIgnored === true });
  // The write target must be the worktree root itself, not a folder inside it.
  const atRoot = prep.ok ? relative(prep.before.root, cwd) === '' : prep.reason === 'workspace-rejected' && relative(prep.snapshot.root, cwd) === '';
  const chosen = await applyPolicy(args.workflow, args.policy, args.task, args.steps, deps, args.modelRouting, args.evalGroup);
  const pfs = await preflightSteps(args.workflow, chosen.requests, { task: args.task, acceptUnverified: args.acceptUnverified, cwd }, chosen.deps);
  const [planPf, implementPf, reviewPf] = pfs;
  if (planPf === undefined || implementPf === undefined || reviewPf === undefined) throw new Error('plan-implement-review needs plan, implement and review steps');
  const ready = prep.ok && atRoot && pfs.every(stepOk);
  const total = args.verify === undefined ? 4 : 5;
  const n = (i: number) => `step ${String(i)}/${String(total)}`;
  const snapshot = prep.ok ? prep.before : prep.reason === 'workspace-rejected' ? prep.snapshot : undefined;

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
        policyLine(args.policy, chosen.quotaNote, args.modelRouting) +
        `  ${n(1)} plan [${planPf.provider}]: ${readOnlyMode(planPf)}, subscription login: ${stepVerdict(planPf)}\n` +
        selectionLines(planPf) +
        stepDetails(planPf) +
        `  ${n(2)} implement [${implementPf.provider}]: ${
          implementPf.provider === 'codex'
            ? `WRITE sandbox limited to the workspace, git ${implementPf.codex?.git ?? 'unknown'}`
            : `WRITE tools (Edit/Write confined to the workspace by --restricted; no shell tool, the test command runs only as the local verify step; protected files (.env*, .git, .github/workflows, .claude, ...) denied before any edit or read; everything else denied)`
        }, subscription login: ${stepVerdict(implementPf)}\n` +
        selectionLines(implementPf) +
        stepDetails(implementPf) +
        `  ${n(3)} inspect [local]: read-only Git comparison with the state above, always runs, even after a failure or cancel\n` +
        `      checks: ignored files too (by fingerprint; ${snapshot === undefined ? 'unknown' : snapshot.ignoredPartial.length === 0 ? 'compared in full' : `PARTIAL, one level deep in ${snapshot.ignoredPartial.join(', ')}`}), symlink/type/mode/submodule changes, writes into the main worktree\n` +
        `      limits: ${String(limits.maxFiles)} files, ${String(limits.maxChangedLines)} changed lines, ${String(limits.maxNewFileBytes)} bytes per new file; no binary files, symlinks, commits, branch changes or protected paths (.git, .github/workflows, .claude, .env*, ...)\n` +
        '      review input: tracked diff plus new text files in full; a change that does not fit completely is rejected (review-incomplete), never reviewed in part\n' +
        (args.verify === undefined
          ? ''
          : `  ${n(4)} verify [local]: ${[args.verify.command, ...args.verify.args].join(' ')} (no shell, cleaned environment; runs the newly written code inside an OS sandbox when one is proven to work here (write only to the worktree, no network, credential folders unreadable); otherwise it is NOT run unless --verify-unsandboxed is given; refused if build/test config files changed, state re-checked afterwards)\n`) +
        `  ${n(total)} review [${reviewPf.provider}]: ${readOnlyMode(reviewPf)}; sees the plan, the change report with the diff, and the verification result as untrusted data (at most ${String(MAX_HANDOFF_CHARS)} characters each); subscription login: ${stepVerdict(reviewPf)}\n` +
        selectionLines(reviewPf) +
        stepDetails(reviewPf) +
        (args.verify === undefined ? '' : await sandboxLine(args.verifyUnsandboxed === true, deps)) +
        '  guarantees: no commit, no push, no branch or main-tree changes, no workspace creation, no revert or delete, no retries, no provider fallback, no API keys, ultracode never selected\n' +
        '  on failure or cancel: the workspace keeps whatever was written; the final state is reported and nothing is rolled back\n' +
        `  managed policy: ${MANAGED_POLICY_LIMIT}\n` +
        '  requires: --confirm-write' +
        (args.verify === undefined ? '' : ', --confirm-verify') +
        `${pfs.some((p) => stepSelection(p).issues.length > 0) ? ', --accept-unverified' : ''}\n` +
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
        pfs.filter((p) => !stepOk(p)).map((p) => `  step ${p.step} [${p.provider}]: ${stepVerdict(p).replace('would refuse: ', '')}\n${stepDetails(p)}`).join(''),
    );
    return 1;
  }
  io.error(
    `orchestrating ${args.workflow}: ${implementPf.provider === 'codex' ? 'Codex' : 'Claude'} may WRITE files in ${cwd} (branch ${prep.before.branch ?? ''}); no commit, no push, no retries, no fallback\n` +
      pfs.map(stepWarnings).join(''),
  );
  const verifyCommand = args.verify;
  const guard = createVerificationGuard({ cwd, git: gitDeps });
  const built = planImplementReviewSteps({
    task: args.task,
    cwd,
    claudeSelection: stepSelection(planPf),
    codexSelection: stepSelection(implementPf),
    reviewSelection: stepSelection(reviewPf),
    planChoice: { provider: planPf.provider, selection: stepSelection(planPf), profile: planPf.profile },
    implementChoice: { provider: implementPf.provider, selection: stepSelection(implementPf), profile: 'workspace-write' },
    reviewChoice: { provider: reviewPf.provider, selection: stepSelection(reviewPf), profile: reviewPf.profile },
    timeoutMs: args.timeoutMs,
    inspect: createWorkspaceInspector({ cwd, before: prep.before, git: gitDeps }),
    ...(verifyCommand === undefined || args.confirmVerify !== true
      ? {}
      : {
          verify: async (signal: AbortSignal | undefined) => {
            const refused = await guard.gate();
            if (refused !== undefined) return refused;
            const decision = args.verifyUnsandboxed === true ? undefined : (deps.sandbox ?? (await resolveSandbox()));
            if (decision?.mode === 'unavailable') {
              return { kind: 'rejected', error: `the test command was not run: no working OS sandbox (${decision.reason}). Run the tests yourself after reading the diff, or add --verify-unsandboxed to run it without isolation (full user rights)` };
            }
            const outcome = await runVerify(
              { command: verifyCommand, cwd, timeoutMs: args.timeoutMs, ...(signal === undefined ? {} : { signal }) },
              { ...(deps.runner === undefined ? {} : { runner: deps.runner }), ...(deps.env === undefined ? {} : { env: deps.env }), ...(decision?.mode === 'sandboxed' ? { sandbox: decision.provider } : {}) },
            );
            return guard.after(outcome);
          },
        }),
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });
  const begun = await beginTask(deps.tasks, args.record !== false, { workflow: args.workflow, cwd, now: (deps.now ?? (() => new Date()))(), git: gitDeps });
  const withCtx = await applyInstructionContext(built, args.withInstructions === true, cwd, (deps.nonce ?? randomUUID)());
  io.error(withCtx.line);
  const steps = withCtx.steps;
  const result = await executeWorkflow(args.workflow, steps, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    onUpdate: (step, index, count) => {
      if (step.status === 'running') io.error(`${formatStep(step, index, count)}\n`);
      else io.error(`${formatStep(step, index, count)}${step.error === undefined ? '' : `: ${step.error}`}\n`);
    },
  });
  io.out(formatResult(result));
  io.error(await recordRun(deps.outcomes, args.record !== false, args.workflow, args.task, chosen.requests, result, args.evalGroup, (deps.now ?? (() => new Date()))()));
  io.error(await recordTask(deps.tasks, args.record !== false, { workflow: args.workflow, cwd, result, begun, now: (deps.now ?? (() => new Date()))(), git: gitDeps }));
  const wrote = result.steps.some((s) => s.id === 'implement' && s.status !== 'skipped' && s.status !== 'pending');
  const partial = wrote && result.status !== 'completed' ? 'The workspace may contain partial changes; nothing was reverted. ' : '';
  io.out(
    partial +
      `Nothing was committed or pushed. Review the changes yourself: git -C "${cwd}" status && git -C "${cwd}" diff\n`,
  );
  return result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
}

/** What the verification command would run under on this machine, proven by a real probe, not assumed. */
async function sandboxLine(unsandboxed: boolean, deps: OrchestrateDeps): Promise<string> {
  if (unsandboxed) return '  sandbox: OFF by --verify-unsandboxed; the test command would run with your full user rights\n';
  const decision = deps.sandbox ?? (await resolveSandbox());
  return decision.mode === 'sandboxed'
    ? `  sandbox: ${decision.provider.name}, checked just now (write only to the worktree and a private temp dir, no network, credential folders unreadable)\n`
    : `  sandbox: NONE (${decision.reason}); the test command would be refused unless --verify-unsandboxed is added\n`;
}
