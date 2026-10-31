import type { AuthStatus } from './auth.ts';
import { sanitize, validateTask, MAX_RUN_OUTPUT_BYTES, MAX_RUN_TIMEOUT_MS, type CodexRunOutcome } from './codex-run.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';
import type { SettingsFinding, SettingsScan } from './claude-settings.ts';
import type { Selection, SelectionIssue } from './selection.ts';
import { isModelId } from './step-selection.ts';
import type { PermissionProfile } from './permission-profile.ts';

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
  ],
);
const ENV_ALLOWED_PREFIXES = ['LC_', 'XDG_'];

/**
 * An allowlist, not a blocklist: the child gets only what it needs to run and to find its
 * normal login. Proxy and TLS variables (`*_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`) are
 * deliberately not forwarded: the subscription connection goes directly, never through a proxy
 * or an extra trust root inherited from the parent. API keys, auth tokens, base URLs, model overrides, Bedrock/Vertex/Foundry
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
 * `--restricted` removes code-running tools and ignores user, project and local settings
 * files (managed settings still apply, which is why they are scanned separately);
 * `--no-session-persistence` keeps nothing on disk; `--permission-prompts none` denies
 * anything that would prompt. Ultracode is passed through `--effort ultracode`.
 */
export function buildClaudePrintArgs(selection: Selection, policy: ClaudeToolPolicy = { profile: 'text-only' }): string[] {
  const tooled = policy.profile !== 'text-only';
  return [
    '-p',
    '--tools',
    tooled ? claudeTools(policy.profile).join(',') : '',
    '--strict-mcp-config',
    '--restricted',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    // `dontAsk` denies everything that is not pre-approved below; bypassPermissions is never built.
    ...(tooled ? ['--permission-mode', 'dontAsk', '--allowedTools', ...claudeAllowRules(policy), '--disallowedTools', ...CLAUDE_DENY_RULES, ...claudeProtectedPathRules()] : []),
    '--output-format',
    'json',
    ...(selection.model.kind === 'explicit' ? ['--model', selection.model.value] : []),
    ...(selection.mode === 'ultracode'
      ? ['--effort', 'ultracode']
      : selection.effort.kind === 'explicit'
        ? ['--effort', selection.effort.value]
        : []),
  ];
}

/** Tool access of a Claude step. The terminal is fixed: the verification command is never added here, it runs only in the local verify step after inspection. */
export interface ClaudeToolPolicy {
  readonly profile: PermissionProfile;
}

/**
 * No shell tool at all. Per the official permission docs, built-in "read-only" Bash commands (cat, grep, find,
 * git diff, ...) run without approval in every mode, the set is not configurable, and Read/Edit deny rules do not
 * cover commands that read files without naming them or subprocesses. A shell would therefore bypass the
 * protected-path rules, so none is offered: `Bash` is absent from `--tools` and denied by its bare name.
 * Verification commands run only as the host's local verify step.
 */
const CLAUDE_DENY_RULES: readonly string[] = ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit'];

/** Built-in tools of a tooled profile; without Bash nothing can run a command. */
export function claudeTools(profile: PermissionProfile): string[] {
  return profile === 'workspace-write' ? ['Read', 'Grep', 'Glob', 'Edit', 'Write'] : ['Read', 'Grep', 'Glob'];
}

export function claudeAllowRules(policy: ClaudeToolPolicy): string[] {
  return [
    'Read', 'Grep', 'Glob',
    ...(policy.profile === 'workspace-write' ? ['Edit', 'Write'] : []),
  ];
}

/**
 * Official permission rules (gitignore-style paths relative to the working directory; deny wins over allow),
 * mirroring `isProtectedPath`. Only `Edit(path)` and `Read(path)` are ever matched: `Edit` covers every built-in
 * file-editing tool (Write included) and `Read` covers Read and, best effort, Grep/Glob; a `Read` deny also blocks
 * Edit/Write on the same path. `Write(path)` rules never match, so none are built. Applied in every tooled profile.
 */
const PROTECTED_DIRS = ['.git', '.claude', '.codex', '.husky'];
const PROTECTED_FILES = ['.env', '.env.*', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', '.gitmodules', '.gitattributes', 'CLAUDE.md', 'AGENTS.md', 'claude.md', 'agents.md'];
/** Instruction and attribute files may be read (they steer the work) but never edited. */
const READABLE_PROTECTED = new Set(['.gitmodules', '.gitattributes', 'CLAUDE.md', 'AGENTS.md', 'claude.md', 'agents.md']);

export function claudeProtectedPathRules(): string[] {
  const dirs = [...PROTECTED_DIRS.map((d) => `**/${d}/**`), '.github/workflows/**'];
  const files = PROTECTED_FILES.map((f) => `**/${f}`);
  return [
    ...[...dirs, ...files].map((p) => `Edit(${p})`),
    ...[...dirs, ...files.filter((_f, i) => !READABLE_PROTECTED.has(PROTECTED_FILES[i] ?? ''))].map((p) => `Read(${p})`),
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
  | 'claude-version-unknown'
  | 'claude-flags-unverified'
  | 'settings-unsafe'
  | 'settings-unverifiable'
  | 'network-env-not-forwarded'
  | 'selection-blocked'
  | 'unverified-selection';

export type ClaudeRunPlan =
  | { readonly ok: true; readonly warnings: readonly SelectionIssue[] }
  | {
      readonly ok: false;
      readonly reason: ClaudeRefusalReason;
      readonly issues: readonly SelectionIssue[];
      readonly findings: readonly SettingsFinding[];
    };

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
  /** Required CLI flags missing from `claude --help`, or `undefined` if help could not be read. */
  missingFlags: readonly string[] | undefined;
  settings: SettingsScan;
  /** Names of proxy/TLS/base-URL variables set in the caller's environment (see `redirectingEnvNames`). */
  networkRedirects?: readonly string[];
  acceptUnverified: boolean;
}): ClaudeRunPlan {
  const refuse = (
    reason: ClaudeRefusalReason,
    issues: readonly SelectionIssue[] = [],
    findings: readonly SettingsFinding[] = [],
  ): ClaudeRunPlan => ({ ok: false, reason, issues, findings });
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
  // Fail closed: if the CLI's flags or the settings files cannot be verified, nothing runs.
  if (input.missingFlags === undefined || input.missingFlags.length > 0) return refuse('claude-flags-unverified');
  if (input.settings.status === 'unverifiable') return refuse('settings-unverifiable');
  if (input.settings.status === 'unsafe') return refuse('settings-unsafe', [], input.settings.findings);
  // These variables are not forwarded, so the run would connect differently than the caller's
  // own shell does. Say so instead of silently changing the network path.
  if ((input.networkRedirects?.length ?? 0) > 0 && !input.acceptUnverified) return refuse('network-env-not-forwarded');
  if (selection.blocked) return refuse('selection-blocked', selection.issues.filter((i) => i.blocking));
  if (selection.mode === 'ultracode') {
    if (input.version === undefined) return refuse('claude-version-unknown');
    const comparison = compareVersions(input.version, MIN_ULTRACODE_VERSION);
    if (comparison === undefined) return refuse('claude-version-unknown');
    if (comparison < 0) return refuse('claude-version-unsupported');
  }
  if (selection.issues.length > 0 && !input.acceptUnverified) return refuse('unverified-selection', selection.issues);
  return { ok: true, warnings: selection.issues };
}

/** Models the response itself reports as used; `undefined` means UNKNOWN (never guessed from the request). */
export type ClaudeRunOutcome =
  | Exclude<CodexRunOutcome, { kind: 'completed' }>
  /** The whole answer was tool-call markup. No tool exists in this run, so nothing was executed and there is no answer. */
  | { readonly kind: 'tool-call-text' }
  | { readonly kind: 'completed'; readonly output: string; readonly truncated: boolean; readonly usedModels?: readonly string[] };

const MAX_USED_MODELS = 8;

const TOOL_TAG = '(?:antml:)?(?:function_calls|invoke|tool_call|tool_use)';

/**
 * True when the entire answer is a tool-call block (`<invoke name="Glob">...`) and nothing else. The run has no
 * tools (`--tools ""`), so such text is the model imitating a call, never a tool result. Markup inside prose, a
 * code fence or next to other text is a normal answer and is not matched.
 */
export function isToolCallOnly(text: string): boolean {
  const t = text.trim();
  if (!new RegExp(`^<${TOOL_TAG}\\b`).test(t)) return false;
  const stripped = t.replace(new RegExp(`<${TOOL_TAG}\\b[^>]*>[\\s\\S]*?(?:</${TOOL_TAG}>|$)`, 'g'), '').replace(new RegExp(`</${TOOL_TAG}>`, 'g'), '').trim();
  return stripped === '';
}

/**
 * Reads `--output-format json`. Only the answer text and the keys of `modelUsage` are kept; the session id,
 * token counts, cost and every other field are dropped on the spot and never logged or stored. Anything that
 * is not a successful result object with a string `result` is `undefined` (the run then counts as failed and
 * no raw text is surfaced).
 */
export function parseClaudeJson(stdout: string): { text: string; usedModels: readonly string[] | undefined } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const result = Array.isArray(data) ? record([...(data as unknown[])].reverse().find((e) => record(e)?.['type'] === 'result')) : record(data);
  if (result === undefined || result['type'] !== 'result' || result['is_error'] === true) return undefined;
  if (result['subtype'] !== undefined && result['subtype'] !== 'success') return undefined;
  const text = result['result'];
  if (typeof text !== 'string') return undefined;
  const usage = record(result['modelUsage']);
  const models = usage === undefined ? [] : Object.keys(usage).filter(isModelId);
  const usedModels = usage === undefined || models.length === 0 || models.length > MAX_USED_MODELS || models.length !== Object.keys(usage).length ? undefined : models;
  return { text, usedModels };
}

export interface ClaudeRunRequest {
  readonly task: string;
  /** Explicit, already validated working directory. */
  readonly cwd: string;
  readonly selection: Selection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Defaults to tool-less (`text-only`). */
  readonly policy?: ClaudeToolPolicy;
}

export interface ClaudeRunDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/** Room for the JSON envelope around an answer of up to `MAX_RUN_OUTPUT_BYTES`. */
const JSON_ENVELOPE_BYTES = 16 * 1024;

/** Runs a tool-less `claude -p` in a cleaned environment. Failure output is never surfaced. */
export async function runClaude(request: ClaudeRunRequest, deps: ClaudeRunDeps = {}): Promise<ClaudeRunOutcome> {
  const runner = deps.runner ?? runProcess;
  const outcome = await runner({
    command: 'claude',
    args: buildClaudePrintArgs(request.selection, request.policy),
    cwd: request.cwd,
    env: claudeRunEnv(deps.env ?? process.env),
    input: request.task,
    timeoutMs: Math.min(Math.max(1, request.timeoutMs), MAX_RUN_TIMEOUT_MS),
    maxOutputBytes: MAX_RUN_OUTPUT_BYTES + JSON_ENVELOPE_BYTES,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  switch (outcome.kind) {
    case 'completed': {
      if (outcome.exitCode !== 0 || outcome.truncated) return { kind: 'failed' };
      const parsed = parseClaudeJson(outcome.stdout);
      if (parsed === undefined) return { kind: 'failed' };
      const text = sanitize(parsed.text);
      if ((request.policy?.profile ?? 'text-only') === 'text-only' && isToolCallOnly(text)) return { kind: 'tool-call-text' };
      const cut = Buffer.byteLength(text) > MAX_RUN_OUTPUT_BYTES;
      return {
        kind: 'completed',
        output: cut ? Buffer.from(text).subarray(0, MAX_RUN_OUTPUT_BYTES).toString('utf8').replace(/\uFFFD+$/u, '') : text,
        truncated: cut,
        ...(parsed.usedModels === undefined ? {} : { usedModels: parsed.usedModels }),
      };
    }
    case 'not-found':
      return { kind: 'not-installed' };
    default:
      return { kind: outcome.kind };
  }
}
