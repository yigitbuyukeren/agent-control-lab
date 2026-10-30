import { realpath, stat } from 'node:fs/promises';
import type { AuthStatus } from './auth.ts';
import type { GitState } from './git-preflight.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';
import type { Selection, SelectionIssue } from './selection.ts';

export const MAX_TASK_CHARS = 20_000;
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_RUN_OUTPUT_BYTES = 64 * 1024;

/** Variables that could silently move Codex onto API-key billing. */
const API_KEY_VARIABLES: ReadonlySet<string> = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY']);

export function codexRunEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !API_KEY_VARIABLES.has(key.toUpperCase())));
}

/**
 * Verified against `codex exec --help`: `-s read-only` sandbox, `-m` model, `-c key=value`
 * config override (bare values fall back to literal strings), `--ephemeral`, `--color never`,
 * and `-` to read the prompt from stdin. No bypass or write-capable flags are ever built.
 */
export function buildCodexExecArgs(selection: Selection): string[] {
  return [
    'exec',
    '-s',
    'read-only',
    '--color',
    'never',
    '--ephemeral',
    ...(selection.model.kind === 'explicit' ? ['-m', selection.model.value] : []),
    ...(selection.effort.kind === 'explicit' ? ['-c', `model_reasoning_effort=${selection.effort.value}`] : []),
    '-',
  ];
}

export function validateTask(task: string): boolean {
  return task.trim() !== '' && task.length <= MAX_TASK_CHARS && !task.includes('\0');
}

/** Resolves an explicit, existing directory; undefined if it is missing or not a directory. */
export async function validateWorkingDir(dir: string): Promise<string | undefined> {
  if (dir === '' || dir.includes('\0')) return undefined;
  try {
    const real = await realpath(dir);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export type RefusalReason =
  | 'task-invalid'
  | 'not-a-git-repo'
  | 'git-not-installed'
  | 'git-check-failed'
  | 'codex-not-installed'
  | 'not-logged-in'
  | 'login-state-unknown'
  | 'api-key-login'
  | 'login-method-unknown'
  | 'selection-blocked'
  | 'unverified-selection';

export type RunPlan =
  | { readonly ok: true; readonly warnings: readonly SelectionIssue[] }
  | { readonly ok: false; readonly reason: RefusalReason; readonly issues: readonly SelectionIssue[] };

/**
 * Pure preflight: a Git work tree, a subscription login and no blocking selection issue are
 * required; unverified (non-blocking) issues additionally need an explicit acceptance.
 * Blocking issues can never be accepted away.
 */
export function planCodexRun(input: {
  task: string;
  auth: AuthStatus;
  selection: Selection;
  git: GitState;
  acceptUnverified: boolean;
}): RunPlan {
  const refuse = (reason: RefusalReason, issues: readonly SelectionIssue[] = []): RunPlan => ({ ok: false, reason, issues });
  const { auth, selection } = input;
  if (!validateTask(input.task)) return refuse('task-invalid');
  if (input.git === 'not-a-repo') return refuse('not-a-git-repo');
  if (input.git === 'git-not-installed') return refuse('git-not-installed');
  if (input.git === 'check-failed') return refuse('git-check-failed');
  if (auth.state === 'not-installed') return refuse('codex-not-installed');
  if (auth.state === 'logged-out') return refuse('not-logged-in');
  if (auth.state !== 'logged-in') return refuse('login-state-unknown');
  if (auth.method === 'api-key') return refuse('api-key-login');
  if (auth.method !== 'subscription') return refuse('login-method-unknown');
  if (selection.blocked) return refuse('selection-blocked', selection.issues.filter((i) => i.blocking));
  if (selection.issues.length > 0 && !input.acceptUnverified) return refuse('unverified-selection', selection.issues);
  return { ok: true, warnings: selection.issues };
}

export type CodexRunOutcome =
  | { readonly kind: 'completed'; readonly output: string; readonly truncated: boolean }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'spawn-failed' };

export interface CodexRunRequest {
  readonly task: string;
  /** Explicit, already validated working directory. */
  readonly cwd: string;
  readonly selection: Selection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface CodexRunDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function sanitize(text: string): string {
  return text.replace(CONTROL, '');
}

/** Runs `codex exec` read-only. Raw stderr and failure output are never surfaced. */
export async function runCodex(request: CodexRunRequest, deps: CodexRunDeps = {}): Promise<CodexRunOutcome> {
  const runner = deps.runner ?? runProcess;
  const outcome = await runner({
    command: 'codex',
    args: buildCodexExecArgs(request.selection),
    cwd: request.cwd,
    env: codexRunEnv(deps.env ?? process.env),
    input: request.task,
    timeoutMs: Math.min(Math.max(1, request.timeoutMs), MAX_RUN_TIMEOUT_MS),
    maxOutputBytes: MAX_RUN_OUTPUT_BYTES,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  switch (outcome.kind) {
    case 'completed':
      return outcome.exitCode === 0
        ? { kind: 'completed', output: sanitize(outcome.stdout), truncated: outcome.truncated }
        : { kind: 'failed' };
    case 'not-found':
      return { kind: 'not-installed' };
    default:
      return { kind: outcome.kind };
  }
}
