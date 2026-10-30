import type { AuthStatus } from './auth.ts';
import { sanitize, validateTask, MAX_RUN_OUTPUT_BYTES, MAX_RUN_TIMEOUT_MS, type CodexRunOutcome } from './codex-run.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';
import type { Selection, SelectionIssue } from './selection.ts';

/** Lowest Claude Code version verified to accept `--effort ultracode` without a warning. */
export const MIN_ULTRACODE_VERSION = '2.1.312';

/** Subscription plans accepted for runs. */
const SUBSCRIPTION_PLANS: ReadonlySet<string> = new Set(['pro', 'max']);

/** Variables a Claude Code child needs to start and keep its normal login working. */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set(
  [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LOGNAME',
    'LANG', 'LANGUAGE', 'TERM', 'TZ', 'DBUS_SESSION_BUS_ADDRESS', 'CLAUDE_CONFIG_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ],
);
const ENV_ALLOWED_PREFIXES = ['LC_', 'XDG_'];

/**
 * An allowlist, not a blocklist: the child gets only what it needs to run and to find its
 * normal login. API keys, auth tokens, base URLs, model overrides, Bedrock/Vertex/Foundry
 * switches, and every other `CLAUDE*`/`ANTHROPIC*` variable (including those of a parent
 * Claude Code session) never reach it.
 */
export function claudeRunEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase();
      return ENV_ALLOWLIST.has(name) || ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
    }),
  );
}

/**
 * Verified against `claude --help` (2.1.312): `-p` prompts from stdin; `--tools ""` disables
 * every built-in tool; `--strict-mcp-config` without `--mcp-config` loads no MCP servers;
 * `--safe-mode` disables hooks, plugins, skills and MCP customisations (auth still works);
 * `--no-session-persistence` keeps nothing on disk; `--permission-prompts none` denies
 * anything that would prompt. Ultracode is passed through `--effort ultracode`.
 */
export function buildClaudePrintArgs(selection: Selection): string[] {
  return [
    '-p',
    '--tools',
    '',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--output-format',
    'text',
    ...(selection.model.kind === 'explicit' ? ['--model', selection.model.value] : []),
    ...(selection.mode === 'ultracode'
      ? ['--effort', 'ultracode']
      : selection.effort.kind === 'explicit'
        ? ['--effort', selection.effort.value]
        : []),
  ];
}

/** Compares dotted numeric versions; undefined when either side is not parseable. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type ClaudeRefusalReason =
  | 'task-invalid'
  | 'claude-not-installed'
  | 'not-logged-in'
  | 'login-state-unknown'
  | 'api-key-login'
  | 'third-party-provider'
  | 'not-a-subscription-plan'
  | 'claude-version-unsupported'
  | 'selection-blocked'
  | 'unverified-selection';

export type ClaudeRunPlan =
  | { readonly ok: true; readonly warnings: readonly SelectionIssue[] }
  | { readonly ok: false; readonly reason: ClaudeRefusalReason; readonly issues: readonly SelectionIssue[] };

/**
 * Pure preflight: a verified Pro/Max subscription login on Anthropic's own API and no blocking
 * selection issue are required; unverified issues also need explicit acceptance. Ultracode
 * additionally needs a Claude Code version known to accept it.
 */
export function planClaudeRun(input: {
  task: string;
  auth: AuthStatus;
  selection: Selection;
  version: string | undefined;
  acceptUnverified: boolean;
}): ClaudeRunPlan {
  const refuse = (reason: ClaudeRefusalReason, issues: readonly SelectionIssue[] = []): ClaudeRunPlan => ({ ok: false, reason, issues });
  const { auth, selection } = input;
  if (!validateTask(input.task)) return refuse('task-invalid');
  if (auth.state === 'not-installed') return refuse('claude-not-installed');
  if (auth.state === 'logged-out') return refuse('not-logged-in');
  if (auth.state !== 'logged-in') return refuse('login-state-unknown');
  if (auth.method === 'api-key') return refuse('api-key-login');
  if (auth.method === 'third-party') return refuse('third-party-provider');
  if (auth.method !== 'subscription' || auth.plan === undefined || !SUBSCRIPTION_PLANS.has(auth.plan)) {
    return refuse('not-a-subscription-plan');
  }
  if (selection.blocked) return refuse('selection-blocked', selection.issues.filter((i) => i.blocking));
  if (selection.mode === 'ultracode') {
    const comparison = input.version === undefined ? undefined : compareVersions(input.version, MIN_ULTRACODE_VERSION);
    if (comparison !== undefined && comparison < 0) return refuse('claude-version-unsupported');
  }
  if (selection.issues.length > 0 && !input.acceptUnverified) return refuse('unverified-selection', selection.issues);
  return { ok: true, warnings: selection.issues };
}

export type ClaudeRunOutcome = CodexRunOutcome;

export interface ClaudeRunRequest {
  readonly task: string;
  /** Explicit, already validated working directory. */
  readonly cwd: string;
  readonly selection: Selection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ClaudeRunDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/** Runs a tool-less `claude -p` in a cleaned environment. Failure output is never surfaced. */
export async function runClaude(request: ClaudeRunRequest, deps: ClaudeRunDeps = {}): Promise<ClaudeRunOutcome> {
  const runner = deps.runner ?? runProcess;
  const outcome = await runner({
    command: 'claude',
    args: buildClaudePrintArgs(request.selection),
    cwd: request.cwd,
    env: claudeRunEnv(deps.env ?? process.env),
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
