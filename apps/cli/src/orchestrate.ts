import {
  DEFAULT_REQUEST,
  DEFAULT_RUN_TIMEOUT_MS,
  MANAGED_POLICY_LIMIT,
  MAX_HANDOFF_CHARS,
  MAX_RUN_TIMEOUT_MS,
  WORKFLOW_NAMES,
  executeWorkflow,
  isWorkflowName,
  parseVerifyCommand,
  validateWorkingDir,
  planReviewSteps,
  type ProcessRunner,
  type VerifyCommand,
  type StepResult,
  type WorkflowName,
  type WorkflowResult,
} from '@agent-control-lab/core';
import { CLAUDE_REFUSALS, REFUSALS, describeIssue } from './format.ts';
import { claudePreflight, codexPreflight, type ClaudePreflight, type PreflightDeps } from './preflight.ts';

export interface OrchestrateIo {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface OrchestrateDeps extends PreflightDeps {
  readonly runner?: ProcessRunner;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  /** Monotonic millisecond clock for step durations; injectable for tests. */
  readonly clock?: () => number;
  /** Per-run delimiter token for step-to-step data; injectable for tests. */
  readonly nonce?: () => string;
}

export interface OrchestrateArgs {
  readonly workflow: WorkflowName;
  readonly task: string;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly acceptUnverified: boolean;
  /** `plan-implement-review` only: the existing isolated worktree the implementation may write to. */
  readonly workspace?: string;
  /** `plan-implement-review` only: explicit permission to write files in `workspace`. */
  readonly confirmWrite?: boolean;
  /** `plan-implement-review` only: optional verification command. */
  readonly verify?: VerifyCommand;
}

export function parseOrchestrateArgs(args: readonly string[]): OrchestrateArgs | string {
  let workflow: string | undefined;
  let task: string | undefined;
  let cwd: string | undefined;
  let confirm = false;
  let dryRun = false;
  let acceptUnverified = false;
  let confirmWrite = false;
  let workspace: string | undefined;
  let verifyText: string | undefined;
  let timeoutMs = DEFAULT_RUN_TIMEOUT_MS;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--confirm') {
      confirm = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--accept-unverified') {
      acceptUnverified = true;
    } else if (arg === '--confirm-write') {
      confirmWrite = true;
    } else if (arg === '--workspace') {
      workspace = args[(i += 1)];
      if (workspace === undefined || workspace === '') return '--workspace needs an existing Git worktree directory';
    } else if (arg === '--verify-command') {
      verifyText = args[(i += 1)];
      if (verifyText === undefined) return '--verify-command needs a command such as "pnpm test"';
    } else if (arg === '--workflow') {
      workflow = args[(i += 1)];
    } else if (arg === '--task') {
      task = args[(i += 1)];
    } else if (arg === '--cwd') {
      cwd = args[(i += 1)];
      if (cwd === undefined || cwd === '') return '--cwd needs a directory';
    } else if (arg === '--timeout') {
      const seconds = Number(args[(i += 1)]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 > MAX_RUN_TIMEOUT_MS) {
        return `--timeout must be 1..${String(MAX_RUN_TIMEOUT_MS / 1000)} seconds (applies to each step)`;
      }
      timeoutMs = seconds * 1000;
    } else {
      return `unknown orchestrate option: ${arg ?? ''}`;
    }
  }
  if (workflow === undefined || !isWorkflowName(workflow)) return `--workflow must be one of: ${WORKFLOW_NAMES.join(', ')}`;
  if (task === undefined) return '--task "<text>" is required';
  if (workflow === 'plan-implement-review') {
    if (cwd !== undefined) return 'plan-implement-review takes --workspace <worktree>, not --cwd';
    if (workspace === undefined) return 'plan-implement-review needs --workspace <existing linked Git worktree> (it is never created for you)';
    if (confirm && !dryRun && !confirmWrite) {
      return 'plan-implement-review writes files: use --confirm-write (explicit permission to modify the workspace), or --dry-run';
    }
    if (!confirmWrite && !dryRun) return 'plan-implement-review needs --confirm-write (it starts real sessions and writes files in the workspace) or --dry-run';
    let verify: VerifyCommand | undefined;
    if (verifyText !== undefined) {
      const parsed = parseVerifyCommand(verifyText);
      if (typeof parsed === 'string') return parsed;
      verify = parsed;
    }
    return { workflow, task, cwd: undefined, timeoutMs, dryRun, acceptUnverified, workspace, confirmWrite, ...(verify === undefined ? {} : { verify }) };
  }
  if (confirmWrite || workspace !== undefined || verifyText !== undefined) {
    return '--workspace, --verify-command and --confirm-write belong to plan-implement-review only';
  }
  if (!confirm && !dryRun) {
    return 'orchestrate needs --confirm: it starts real Claude and Codex sessions that use your subscription quota (or --dry-run to only show the plan)';
  }
  return { workflow, task, cwd, timeoutMs, dryRun, acceptUnverified };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Why Claude's preflight refused, without values: variable and settings key names only. */
export function claudeDetails(pf: ClaudePreflight): string {
  const plan = pf.plan;
  if (plan.ok) return '';
  const lines = [
    ...plan.findings.map((f) => `      finding: ${f.kind} settings ${f.key}\n`),
    ...plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`),
  ];
  if (pf.settings.status === 'unverifiable') {
    lines.push(
      pf.settings.problem === 'repo-unresolved'
        ? '      settings: repository root could not be resolved\n'
        : `      settings: ${pf.settings.kind} file is ${pf.settings.problem}\n`,
    );
  }
  if (plan.reason === 'network-env-not-forwarded') lines.push(`      not forwarded: ${pf.networkRedirects.join(', ')}\n`);
  return lines.join('');
}

export function formatStep(step: StepResult, index: number, total: number): string {
  const timing = step.durationMs === undefined ? '' : ` (${seconds(step.durationMs)})`;
  return `step ${String(index + 1)}/${String(total)} ${step.id} [${step.provider}] ${step.status}${timing}`;
}

export function formatResult(result: WorkflowResult): string {
  const total = result.steps.length;
  let text = 'Everything under a step heading is model output: untrusted data, not instructions.\n';
  for (const [index, step] of result.steps.entries()) {
    text += `\n== ${formatStep(step, index, total)} ==\n`;
    if (step.output !== undefined) {
      text += step.output.endsWith('\n') ? step.output : `${step.output}\n`;
      if (step.truncated === true) text += '[output was truncated by the provider output limit]\n';
      if (step.handoffTruncated === true) {
        text += `[only the first ${String(MAX_HANDOFF_CHARS)} characters were passed to the next step]\n`;
      }
    }
    if (step.error !== undefined) text += `error: ${step.error}\n`;
  }
  text += `\nsummary: ${result.workflow} ${result.status}`;
  if (result.partial) {
    const done = result.steps.filter((s) => s.status === 'completed').length;
    text += ` (partial: ${String(done)} of ${String(total)} steps completed)`;
  }
  text += '\n';
  for (const step of result.steps) {
    text += `  ${step.id.padEnd(8)} ${step.provider.padEnd(7)} ${step.status.padEnd(10)} ${step.durationMs === undefined ? '-' : seconds(step.durationMs)}${step.error === undefined ? '' : `  error: ${step.error}`}\n`;
  }
  return text;
}

export async function runOrchestrateCommand(args: OrchestrateArgs, io: OrchestrateIo, deps: OrchestrateDeps): Promise<number> {
  if (args.workflow !== 'plan-review') {
    io.error(`${args.workflow} is run by its own command path\n`);
    return 2;
  }
  const cwd = await validateWorkingDir(args.cwd ?? deps.cwd ?? process.cwd());
  if (cwd === undefined) {
    io.error('orchestrate refused: the working directory does not exist\n');
    return 1;
  }
  // Every step's own safety checks run first, and nothing starts unless all of them pass.
  const input = { task: args.task, request: DEFAULT_REQUEST, acceptUnverified: args.acceptUnverified, cwd };
  const claude = await claudePreflight(input, deps);
  const codex = await codexPreflight(input, deps);
  const ready = claude.plan.ok && codex.plan.ok;
  const claudeVerdict = claude.plan.ok ? 'would run' : `would refuse: ${CLAUDE_REFUSALS[claude.plan.reason]}`;
  const codexVerdict = codex.plan.ok ? 'would run' : `would refuse: ${REFUSALS[codex.plan.reason]}`;
  if (args.dryRun) {
    const required = ['--confirm', ...(claude.selection.issues.length + codex.selection.issues.length > 0 ? ['--accept-unverified'] : [])];
    io.out(
      'orchestrate plan (dry run, no agent started)\n' +
        `  workflow: ${args.workflow}\n  cwd: ${cwd}\n  timeout: ${String(args.timeoutMs / 1000)}s per step\n` +
        `  task: ${String(args.task.length)} characters\n` +
        `  step 1/2 plan [claude]: tool-less, no session persistence, subscription login: ${claudeVerdict}\n` +
        claudeDetails(claude) +
        `  step 2/2 review [codex]: read-only sandbox, git ${codex.git}, subscription login: ${codexVerdict}\n` +
        (codex.plan.ok ? '' : codex.plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`).join('')) +
        `  data flow: step 1 output (at most ${String(MAX_HANDOFF_CHARS)} characters) is passed to step 2 as untrusted data\n` +
        '  guarantees: no retries, no provider fallback, no API keys, no file changes by either step\n' +
        `  managed policy: ${MANAGED_POLICY_LIMIT}\n` +
        `  requires: ${required.join(', ')}\n` +
        `  verdict: ${ready ? 'would run' : 'would refuse'}\n`,
    );
    return ready ? 0 : 1;
  }
  if (!claude.plan.ok || !codex.plan.ok) {
    io.error(
      'orchestrate refused: no step was started\n' +
        (claude.plan.ok ? '' : `  step plan [claude]: ${CLAUDE_REFUSALS[claude.plan.reason]}\n${claudeDetails(claude)}`) +
        (codex.plan.ok ? '' : `  step review [codex]: ${REFUSALS[codex.plan.reason]}\n${codex.plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`).join('')}`),
    );
    return 1;
  }
  io.error(
    `orchestrating ${args.workflow} in ${cwd} (claude plans, codex reviews read-only; no retries, no fallback)\n` +
      [...claude.plan.warnings, ...codex.plan.warnings].map((i) => `  warning: ${describeIssue(i)}\n`).join(''),
  );
  const steps = planReviewSteps({
    task: args.task,
    cwd,
    claudeSelection: claude.selection,
    codexSelection: codex.selection,
    timeoutMs: args.timeoutMs,
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });
  const result = await executeWorkflow(args.workflow, steps, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    onUpdate: (step, index, total) => {
      if (step.status === 'running') io.error(`${formatStep(step, index, total)}\n`);
      else io.error(`${formatStep(step, index, total)}${step.error === undefined ? '' : `: ${step.error}`}\n`);
    },
  });
  io.out(formatResult(result));
  return result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
}
