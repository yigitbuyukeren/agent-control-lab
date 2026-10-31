import {
  builtinAdapters,
  defaultExec,
  detectAuthStatuses,
  detectProviders,
  getInfo,
  parseClaudeStatusLine,
  parseCommand,
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_REQUEST,
  MAX_RUN_TIMEOUT_MS,
  ROUTE_PROVIDERS,
  TASK_KINDS,
  asEffortLevel,
  isModelId,
  availabilityFromAuth,
  checkEffort,
  MANAGED_POLICY_LIMIT,
  runClaude,
  runCodex,
  validateWorkingDir,
  claudeRegistry,
  discoverCodexModels,
  isDefaultRequest,
  readAllQuotas,
  resolveSelection,
  routeTask,
  readClaudeCache,
  readCodexQuota,
  resolveCacheDir,
  decodeChain,
  writeClaudeCache,
  type AuthStatus,
  type ClaudeQuotaStatus,
  type CodexModelsResult,
  type EffortCheck,
  type ModelCapability,
  type Selection,
  type SelectionRequest,
  type ProcessRunner,
  type CodexRunOutcome,
  type OutcomeStore,
  type ProviderPreference,
  type ProviderQuota,
  type RouteDecision,
  type TaskKind,
  type UsageWindow,
  type ProviderStatus,
  type QuotaStatus,
  type QuotaWindow,
} from '@agent-control-lab/core';
import { VERSION } from '@agent-control-lab/shared';
import { describeClaudeFacts } from './claude-facts.ts';
import { REFUSALS, CLAUDE_REFUSALS, describeIssue, describePinned } from './format.ts';
import { runChained } from './statusline-chain.ts';
import { runPlanImplementReviewCommand } from './orchestrate-write.ts';
import { formatOutcomes } from './format.ts';
import { parseOrchestrateArgs, runOrchestrateCommand, usedModelLine } from './orchestrate.ts';
import { claudePreflight, codexPreflight, type PreflightDeps } from './preflight.ts';

const HELP = `agent-control-lab ${VERSION}

Usage: agent-control-lab <command>

Commands:
  help      Show this help
  version   Print the version
  info      Print runtime information
  providers Show installed AI CLI providers (local --version check only)
  quota     Show Codex rate-limit usage (read-only app-server query)
  quota all             Show Claude (local cache) and Codex (app-server) limits together
  quota claude          Show Claude Code limits from the local statusLine cache
  quota claude --stdin  Show Claude Code limits from statusLine JSON on stdin
  run --provider codex --task "<text>" --confirm [--accept-unverified] [--model auto|<id>] [--effort auto|<level>] [--cwd <dir>] [--timeout <seconds>]
                        Run Codex read-only inside a Git repository (subscription login only, no API-key fallback)
  run --provider claude --task "<text>" --confirm [--accept-unverified] [--model auto|<id>] [--effort auto|<level>] [--mode normal|ultracode] [--cwd <dir>] [--timeout <seconds>]
                        Run tool-less claude -p (Pro/Max subscription login only, no API key or third party)
  orchestrate --workflow plan-review --task "<text>" (--dry-run | --confirm [--accept-unverified]) [--cwd <dir>] [--timeout <seconds per step>] [--policy economy|balanced|quality] [--model-routing auto|adaptive|measured|research|guided] [--no-record] [--eval-group <label>] [--step-provider <plan|review>=auto|claude|codex] [--step-model <plan|review>=auto|<id>] [--step-effort <plan|review>=auto|<level>]
                        Claude drafts a plan, Codex reviews it read-only (plan/review providers are choosable: --step-provider; Claude steps are tool-less, Codex steps read-only); stops at the first failure (no retry, no fallback)
  orchestrate --workflow plan-implement-review --task "<text>" --workspace <existing linked worktree> (--dry-run | --confirm-write [--accept-unverified] [--allow-partial-ignored-check]) [--verify-command "<pnpm test>" --confirm-verify] [--timeout <seconds per step>] [--policy economy|balanced|quality] [--model-routing auto|adaptive|measured|research|guided] [--no-record] [--eval-group <label>] [--step-provider <plan|review>=auto|claude|codex] [--step-model <plan|implement|review>=auto|<id>] [--step-effort <plan|implement|review>=auto|<level>]
                        Claude plans, Codex WRITES in that worktree only, limits are checked, Claude reviews the diff; no commit or push (plan/review providers choosable; implement always Codex, no Claude write runner)
  run --provider <codex|claude> --task "<text>" --dry-run [...]
                        Show the run plan without starting any agent
  models                List known models and efforts (Claude: documented, unverified; Codex: discovered)
  outcomes [clear]      Show (or delete) the local pass/fail records used by --model-routing measured
  models claude         Show what can be verified about Claude models without a model call (rest: UNKNOWN)
  models check <claude|codex> <model> <effort>
                        Exit 0 supported, 1 unsupported, 3 unknown
  route --dry-run --task <kind> [--prefer claude|codex|auto] [--model auto|<id>] [--effort auto|<level>] [--mode normal|ultracode]
                        Recommend a provider (no agent is started)
  statusline-collect    Store 5h/7d limits from statusLine JSON on stdin (opt-in, see docs/STATUSLINE.md)
  gui [--port <n>]      Local dark-mode browser UI (loopback only): dry-run preview, and real plan-review runs only after a matching preview and explicit confirmation
  auth-status Show provider login state and method (local status commands only)
`;

export interface Io {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface Deps extends PreflightDeps {
  readonly readStdin?: () => Promise<string>;
  readonly cacheDir?: string;
  /** Local outcome records (`outcomes`, `--model-routing measured`); the executable supplies the file store. */
  readonly outcomes?: OutcomeStore;
  readonly runner?: ProcessRunner;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly now?: () => Date;
  /** Step duration clock for `orchestrate` (milliseconds); defaults to `performance.now()`. */
  readonly clock?: () => number;
  /** Delimiter token for `orchestrate` step data; defaults to a random UUID. */
  readonly nonce?: () => string;
}

function formatProvider(s: ProviderStatus): string {
  const label = s.displayName.padEnd(12);
  switch (s.state) {
    case 'installed':
      return `${label} installed${s.version === undefined ? '' : ` ${s.version}`}\n`;
    case 'not-found':
      return `${label} not installed\n`;
    case 'error':
      return `${label} error: ${s.error ?? 'unknown'}\n`;
  }
}

function formatAuth(s: AuthStatus): string {
  const label = s.displayName.padEnd(12);
  switch (s.state) {
    case 'logged-in': {
      const detail = [s.method === undefined || s.method === 'unknown' ? undefined : s.method, s.plan]
        .filter((part) => part !== undefined)
        .join(', ');
      return `${label} logged in${detail === '' ? '' : ` (${detail})`}\n`;
    }
    case 'logged-out':
      return `${label} not logged in\n`;
    case 'not-installed':
      return `${label} not installed\n`;
    case 'unknown':
      return `${label} unknown\n`;
    case 'error':
      return `${label} error: ${s.error ?? 'unknown'}\n`;
  }
}

function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'unknown window';
  if (minutes % 1440 === 0) return `${String(minutes / 1440)}d window`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}h window`;
  return `${String(minutes)}m window`;
}

function formatWindow(name: string, window: QuotaWindow | undefined): string {
  if (window === undefined) return `  ${name}: unknown\n`;
  const used = window.usedPercent === undefined ? 'usage unknown' : `${String(window.usedPercent)}% used`;
  const reset = window.resetsAt === undefined ? 'reset unknown' : `resets ${window.resetsAt}`;
  return `  ${windowLabel(window.windowMinutes)} (${name}): ${used}, ${reset}\n`;
}

function formatQuota(q: QuotaStatus): string {
  const label = 'Codex';
  switch (q.state) {
    case 'not-installed':
      return `${label} not installed\n`;
    case 'error':
      return `${label} error: ${q.error ?? 'unknown'}\n`;
    case 'ok':
      return `${label} plan: ${q.plan ?? 'unknown'}\n${formatWindow('primary', q.primary)}${formatWindow('secondary', q.secondary)}`;
  }
}

const MAX_STDIN_BYTES = 1024 * 1024;

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) return '';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function formatClaudeLine(label: string, window: QuotaWindow | undefined): string {
  if (window === undefined) return `  ${label}: unknown\n`;
  const used = window.usedPercent === undefined ? 'usage unknown' : `${String(window.usedPercent)}% used`;
  const reset = window.resetsAt === undefined ? 'reset unknown' : `resets ${window.resetsAt}`;
  return `  ${label}: ${used}, ${reset}\n`;
}

function formatClaudeQuota(q: ClaudeQuotaStatus): string {
  const updated = q.updatedAt === undefined ? '' : `  updated ${q.updatedAt}\n`;
  return `Claude Code quota: ${q.state === 'ok' ? 'ok' : 'unknown'}\n${formatClaudeLine('5h window', q.fiveHour)}${formatClaudeLine('7d window', q.sevenDay)}${updated}`;
}

function formatUsageWindow(w: UsageWindow): string {
  const used = w.usedPercent === undefined ? 'usage unknown' : `${String(w.usedPercent)}% used, ${String(w.remainingPercent)}% left`;
  const reset = w.resetsAt === undefined ? 'reset unknown' : `resets ${w.resetsAt}`;
  return `  ${w.label} window: ${used}, ${reset}\n`;
}

function formatProviderQuota(q: ProviderQuota): string {
  if (q.state === 'not-installed') return `${q.displayName}: not installed\n`;
  if (q.state === 'error') return `${q.displayName}: error: ${q.error ?? 'unknown'}\n`;
  const notes = [
    q.source,
    q.freshness === 'unknown' || q.freshness === q.source ? undefined : q.freshness,
    q.updatedAt === undefined ? undefined : `updated ${q.updatedAt}`,
    q.plan === undefined ? undefined : `plan ${q.plan}`,
  ].filter((note) => note !== undefined);
  return `${q.displayName}: ${q.state} (${notes.join(', ')})\n${q.windows.map(formatUsageWindow).join('')}`;
}

interface RouteArgs {
  readonly task: TaskKind;
  readonly preference: ProviderPreference;
  readonly request: SelectionRequest;
}

/** Returns an error message, or undefined when the model id is acceptable. */
function checkModelArg(value: string | undefined): string | undefined {
  return value !== undefined && isModelId(value) ? undefined : '--model must be auto or a model id';
}

function checkEffortArg(value: string | undefined): string | undefined {
  if (value === 'ultracode') return 'ultracode is a work mode, not an effort: use --mode ultracode';
  if (value === 'auto' || (value !== undefined && asEffortLevel(value) !== undefined)) return undefined;
  return '--effort must be auto or a level such as low, medium, high, xhigh, max, ultra';
}

function parseRouteArgs(args: readonly string[]): RouteArgs | string {
  let task: TaskKind | undefined;
  let preference: ProviderPreference = 'auto';
  let dryRun = false;
  let model: string = DEFAULT_REQUEST.model;
  let effort: string = DEFAULT_REQUEST.effort;
  let mode: SelectionRequest['mode'] = DEFAULT_REQUEST.mode;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--task') {
      const value = args[(i += 1)];
      const kind = TASK_KINDS.find((k) => k === value);
      if (kind === undefined) return `--task must be one of: ${TASK_KINDS.join(', ')}`;
      task = kind;
    } else if (arg === '--prefer') {
      const value = args[(i += 1)];
      const choice = [...ROUTE_PROVIDERS, 'auto' as const].find((p) => p === value);
      if (choice === undefined) return '--prefer must be one of: claude, codex, auto';
      preference = choice;
    } else if (arg === '--model') {
      const value = args[(i += 1)];
      const problem = checkModelArg(value);
      if (problem !== undefined || value === undefined) return problem ?? '--model must be auto or a model id';
      model = value;
    } else if (arg === '--effort') {
      const value = args[(i += 1)];
      const problem = checkEffortArg(value);
      if (problem !== undefined || value === undefined) return problem ?? '--effort must be auto or a level';
      effort = value;
    } else if (arg === '--mode') {
      const value = args[(i += 1)];
      if (value !== 'normal' && value !== 'ultracode') return '--mode must be normal or ultracode';
      mode = value;
    } else {
      return `unknown route option: ${arg ?? ''}`;
    }
  }
  if (!dryRun) return 'route only supports --dry-run; nothing is executed';
  if (task === undefined) return `--task is required (${TASK_KINDS.join(', ')})`;
  return { task, preference, request: { model, effort, mode } };
}


function formatSelection(selection: Selection): string {
  return (
    `  model: ${describePinned(selection.model)}\n` +
    `  effort: ${describePinned(selection.effort)}\n` +
    `  mode: ${selection.mode}\n` +
    selection.issues.map((i) => `  issue: ${describeIssue(i)}\n`).join('') +
    `  manual-approval: ${selection.manualApprovalRequired ? 'required' : 'not required'}\n`
  );
}

function formatRoute(args: RouteArgs, decision: RouteDecision, selection?: Selection): string {
  const head = `route (dry run): task=${args.task} prefer=${args.preference}\n`;
  if (decision.kind === 'manual-selection-required') {
    return `${head}manual-selection-required\n${decision.reasons.map((r) => `  reason: ${r}\n`).join('')}`;
  }
  return (
    `${head}recommended: ${decision.provider}\n` +
    decision.reasons.map((r) => `  reason: ${r}\n`).join('') +
    decision.caveats.map((c) => `  caveat: ${c.code} (${c.provider})\n`).join('') +
    (selection === undefined ? '' : formatSelection(selection))
  );
}

function formatModel(m: ModelCapability): string {
  const name = m.displayName === undefined ? m.id : `${m.id} (${m.displayName})`;
  let efforts: string;
  if (m.efforts.status === 'known') {
    const list = m.efforts.supported.join(', ');
    efforts = `efforts ${list}${m.efforts.default === undefined ? '' : `, default ${m.efforts.default}`}`;
  } else {
    efforts = m.provider === 'claude' ? `efforts unknown (documented levels: ${CLAUDE_EFFORT_LEVELS.join(', ')})` : 'efforts unknown';
  }
  const mode = m.modes.ultracode === 'unknown' ? '' : `; ultracode mode ${m.modes.ultracode}`;
  return `  ${name}: ${efforts}${mode}\n`;
}

function formatCodexModels(result: CodexModelsResult): string {
  const head = 'Codex (discovered via app-server model/list)';
  if (result.state === 'not-installed') return `${head}\n  not installed\n`;
  if (result.state === 'error') return `${head}\n  error: ${result.error}\n`;
  return `${head}\n${result.models.length === 0 ? '  none listed\n' : result.models.map(formatModel).join('')}`;
}

function formatEffortCheck(check: EffortCheck): string {
  if (check.status === 'supported') return `supported${check.isDefault ? ' (default)' : ''}\n`;
  if (check.status === 'unsupported') return `unsupported (supported: ${check.supported.join(', ')})\n`;
  return `unknown (${check.reason})\n`;
}

interface RunArgs {
  readonly provider: 'codex' | 'claude';
  readonly task: string;
  readonly request: SelectionRequest;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
  readonly acceptUnverified: boolean;
}

function parseRunArgs(args: readonly string[]): RunArgs | string {
  let provider: string | undefined;
  let task: string | undefined;
  let confirm = false;
  let dryRun = false;
  let acceptUnverified = false;
  let mode: SelectionRequest['mode'] = 'normal';
  let cwd: string | undefined;
  let timeoutMs = DEFAULT_RUN_TIMEOUT_MS;
  let model: string = DEFAULT_REQUEST.model;
  let effort: string = DEFAULT_REQUEST.effort;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--confirm') {
      confirm = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--accept-unverified') {
      acceptUnverified = true;
    } else if (arg === '--provider') {
      provider = args[(i += 1)];
    } else if (arg === '--task') {
      task = args[(i += 1)];
    } else if (arg === '--cwd') {
      cwd = args[(i += 1)];
      if (cwd === undefined || cwd === '') return '--cwd needs a directory';
    } else if (arg === '--timeout') {
      const seconds = Number(args[(i += 1)]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 > MAX_RUN_TIMEOUT_MS) {
        return `--timeout must be 1..${String(MAX_RUN_TIMEOUT_MS / 1000)} seconds`;
      }
      timeoutMs = seconds * 1000;
    } else if (arg === '--model') {
      const value = args[(i += 1)];
      const problem = checkModelArg(value);
      if (problem !== undefined || value === undefined) return problem ?? '--model must be auto or a model id';
      model = value;
    } else if (arg === '--effort') {
      const value = args[(i += 1)];
      const problem = checkEffortArg(value);
      if (problem !== undefined || value === undefined) return problem ?? '--effort must be auto or a level';
      effort = value;
    } else if (arg === '--mode') {
      const value = args[(i += 1)];
      if (value !== 'normal' && value !== 'ultracode') return '--mode must be normal or ultracode';
      mode = value;
    } else {
      return `unknown run option: ${arg ?? ''}`;
    }
  }
  if (provider !== 'codex' && provider !== 'claude') return '--provider must be codex or claude';
  if (provider === 'codex' && mode === 'ultracode') return 'ultracode is not supported for Codex';
  if (task === undefined) return '--task "<text>" is required';
  if (!confirm && !dryRun) {
    return provider === 'claude'
      ? 'run needs --confirm: it starts a real Claude session that uses your subscription quota'
      : 'run needs --confirm: it starts a real, billed Codex session';
  }
  return { provider, task, request: { model, effort, mode }, cwd, timeoutMs, dryRun, acceptUnverified };
}


const RUN_FAILURES: Record<Exclude<CodexRunOutcome['kind'], 'completed'> | 'tool-call-text', string> = {
  'tool-call-text': 'codex answered with tool-call text only; this run has no tools, nothing was executed and there is no answer',
  failed: 'codex run failed',
  timeout: 'codex run timed out',
  cancelled: 'codex run cancelled',
  'not-installed': 'codex is not installed',
  'spawn-failed': 'codex could not be started',
};

async function runClaudeCommand(args: RunArgs, io: Io, deps: Deps): Promise<number> {
  const cwd = await validateWorkingDir(args.cwd ?? deps.cwd ?? process.cwd());
  if (cwd === undefined) {
    io.error('run refused: the working directory does not exist\n');
    return 1;
  }
  const { plan, auth, provider, selection, settings, missingFlags, networkRedirects } = await claudePreflight(
    { task: args.task, request: args.request, acceptUnverified: args.acceptUnverified, cwd },
    deps,
  );
  const findingLines = (plan.ok ? [] : plan.findings).map((f) => `  finding: ${f.kind} settings ${f.key}\n`);
  const settingsLine =
    settings.status !== 'unverifiable'
      ? ''
      : settings.problem === 'repo-unresolved'
        ? '  settings: repository root could not be resolved, so project settings places are unverified\n'
        : `  settings: ${settings.kind} file is ${settings.problem}\n`;
  const networkLine = networkRedirects.length === 0 ? '' : `  not forwarded: ${networkRedirects.join(', ')}\n`;
  if (args.dryRun) {
    const login = auth.state === 'logged-in' ? `${auth.method ?? 'unknown'} login${auth.plan === undefined ? '' : ` (${auth.plan})`}` : auth.state;
    const required = ['--confirm', ...(selection.issues.length > 0 && !selection.blocked ? ['--accept-unverified'] : [])];
    io.out(
      'run plan (dry run, no agent started)\n' +
        `  provider: claude\n  cwd: ${cwd}\n  tools: none (built-in and MCP disabled)\n  session persistence: off\n` +
        `  restricted: on (user, project and local settings ignored)\n` +
        `  flags check: ${missingFlags === undefined ? 'unverified' : missingFlags.length === 0 ? 'ok' : `missing ${missingFlags.join(', ')}`}\n` +
        `  settings check: ${settings.status}\n` +
        findingLines.join('') +
        settingsLine +
        `  managed policy: ${MANAGED_POLICY_LIMIT}\n` +
        networkLine +
        `  login: ${login}\n  cli version: ${provider.version ?? 'unknown'}\n` +
        `  model: ${describePinned(selection.model)}\n  effort: ${describePinned(selection.effort)}\n` +
        `  mode: ${selection.mode}\n  timeout: ${String(args.timeoutMs / 1000)}s\n  task: ${String(args.task.length)} characters\n` +
        selection.issues.map((i) => `  issue: ${describeIssue(i)}\n`).join('') +
        `  requires: ${required.join(', ')}\n` +
        `  verdict: ${plan.ok ? 'would run' : `would refuse: ${CLAUDE_REFUSALS[plan.reason]}`}\n`,
    );
    return plan.ok ? 0 : 1;
  }
  if (!plan.ok) {
    io.error(
      `run refused: ${CLAUDE_REFUSALS[plan.reason]}\n${findingLines.join('')}${settingsLine}${networkLine}` +
        plan.issues.map((i) => `  issue: ${describeIssue(i)}\n`).join(''),
    );
    return 1;
  }
  io.error(
    `running claude (no tools, no session persistence, subscription login) in ${cwd}\n` +
      `  model: ${describePinned(selection.model)}\n  effort: ${describePinned(selection.effort)}\n  mode: ${selection.mode}\n` +
      plan.warnings.map((i) => `  warning: ${describeIssue(i)}\n`).join(''),
  );
  const outcome = await runClaude(
    { task: args.task, cwd, selection, timeoutMs: args.timeoutMs, ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    { ...(deps.runner === undefined ? {} : { runner: deps.runner }), ...(deps.env === undefined ? {} : { env: deps.env }) },
  );
  if (outcome.kind !== 'completed') {
    io.error(`${RUN_FAILURES[outcome.kind].replace('codex', 'claude')}\n`);
    return outcome.kind === 'cancelled' ? 130 : 1;
  }
  io.out(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
  if (outcome.truncated) io.error('output was truncated\n');
  io.error(`${usedModelLine(outcome.usedModels)}\n`);
  return 0;
}

export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    io.error(`${parsed.error}\n\n${HELP}`);
    return 2;
  }
  switch (parsed.value) {
    case 'help':
      io.out(HELP);
      return 0;
    case 'version':
      io.out(`${VERSION}\n`);
      return 0;
    case 'providers': {
      const statuses = await detectProviders(undefined, deps.exec ?? defaultExec);
      io.out(statuses.map(formatProvider).join(''));
      return 0;
    }
    case 'auth-status': {
      const statuses = await detectAuthStatuses(builtinAdapters, deps.exec ?? defaultExec);
      io.out(statuses.map(formatAuth).join(''));
      return 0;
    }
    case 'quota': {
      const [, target, flag] = argv;
      if (target === 'all') {
        const quotas = await readAllQuotas({
          claudeCacheDir: deps.cacheDir ?? resolveCacheDir(),
          ...(deps.appServer === undefined ? {} : { appServer: deps.appServer }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
        io.out(quotas.map(formatProviderQuota).join(''));
        return 0;
      }
      if (target === 'claude') {
        if (flag === undefined) {
          const dir = deps.cacheDir ?? resolveCacheDir();
          const cached =
            dir === undefined ? { state: 'unknown' as const } : await readClaudeCache(dir, (deps.now ?? (() => new Date()))());
          io.out(formatClaudeQuota(cached));
          return 0;
        }
        if (flag !== '--stdin') {
          io.error('usage: agent-control-lab quota claude [--stdin]\n');
          return 2;
        }
        const text = await (deps.readStdin ?? readProcessStdin)();
        io.out(formatClaudeQuota(parseClaudeStatusLine(text)));
        return 0;
      }
      if (target !== undefined && target !== 'codex') {
        io.error(`unknown quota target: ${target}\n`);
        return 2;
      }
      const quota = await readCodexQuota(deps.appServer);
      io.out(formatQuota(quota));
      return 0;
    }
    case 'statusline-collect': {
      // Silent on stdout unless chained: the statusLine command's output would otherwise become the status text.
      const input = await (deps.readStdin ?? readProcessStdin)();
      const chainAt = argv.indexOf('--chain');
      const chained = chainAt === -1 ? undefined : decodeChain(argv[chainAt + 1]);
      if (chainAt !== -1 && chained === undefined) {
        io.error('statusline-collect: --chain needs the encoded original statusLine command\n');
        return 2;
      }
      const status = parseClaudeStatusLine(input);
      const dir = deps.cacheDir ?? resolveCacheDir();
      let failed = false;
      if (status.state === 'ok' && dir !== undefined) {
        try {
          await writeClaudeCache(dir, status, (deps.now ?? (() => new Date()))());
        } catch {
          failed = true;
          io.error('could not write the quota cache\n');
        }
      }
      if (chained === undefined) return failed ? 1 : 0;
      // The user's own status line must keep working whatever happens to the cache.
      const result = await runChained(chained, input);
      if (result.stdout !== '') io.out(result.stdout);
      if (result.stderr !== '') io.error(result.stderr);
      return result.code;
    }
    case 'route': {
      const args = parseRouteArgs(argv.slice(1));
      if (typeof args === 'string') {
        io.error(`${args}\n`);
        return 2;
      }
      const [auth, quotas] = await Promise.all([
        detectAuthStatuses(builtinAdapters, deps.exec ?? defaultExec),
        readAllQuotas({
          claudeCacheDir: deps.cacheDir ?? resolveCacheDir(),
          ...(deps.appServer === undefined ? {} : { appServer: deps.appServer }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        }),
      ]);
      const decision = routeTask({
        task: args.task,
        preference: args.preference,
        availability: availabilityFromAuth(auth),
        quota: Object.fromEntries(quotas.map((q) => [q.provider, q])),
      });
      let selection: Selection | undefined;
      if (decision.kind === 'recommend' && !isDefaultRequest(args.request)) {
        const needsCodexCatalog =
          decision.provider === 'codex' && (args.request.model !== 'auto' || args.request.effort !== 'auto');
        const codex: CodexModelsResult = needsCodexCatalog
          ? await discoverCodexModels(deps.appServer)
          : { state: 'ok', models: [] };
        selection = resolveSelection(decision.provider, args.request, { claude: claudeRegistry, codex });
      }
      io.out(formatRoute(args, decision, selection));
      return 0;
    }
    case 'models': {
      const [, sub, provider, modelId, effort] = argv;
      if (sub === undefined) {
        const codex = await discoverCodexModels(deps.appServer);
        io.out(
          `Claude Code (documented; account access not verified)\n${claudeRegistry.map(formatModel).join('')}` +
            formatCodexModels(codex) +
            'note: ultracode is an optional work mode, not an effort level; support is unknown unless stated.\n',
        );
        return 0;
      }
      if (sub === 'claude' && provider === undefined) {
        io.out(await describeClaudeFacts(deps));
        return 0;
      }
      if (sub !== 'check' || (provider !== 'claude' && provider !== 'codex') || modelId === undefined || effort === undefined) {
        io.error('usage: agent-control-lab models [claude | check <claude|codex> <model> <effort>]\n');
        return 2;
      }
      let registry: readonly ModelCapability[] = claudeRegistry;
      if (provider === 'codex') {
        const codex = await discoverCodexModels(deps.appServer);
        registry = codex.state === 'ok' ? codex.models : [];
      }
      const check = checkEffort(registry, provider, modelId, effort);
      io.out(formatEffortCheck(check));
      return check.status === 'supported' ? 0 : check.status === 'unsupported' ? 1 : 3;
    }
    case 'run': {
      const args = parseRunArgs(argv.slice(1));
      if (typeof args === 'string') {
        io.error(`${args}\n`);
        return 2;
      }
      if (args.provider === 'claude') return runClaudeCommand(args, io, deps);
      const cwd = await validateWorkingDir(args.cwd ?? deps.cwd ?? process.cwd());
      if (cwd === undefined) {
        io.error('run refused: the working directory does not exist\n');
        return 1;
      }
      // All preflight checks are read-only: git rev-parse, codex login status, model/list.
      const { plan, auth, git, selection } = await codexPreflight(
        { task: args.task, request: args.request, acceptUnverified: args.acceptUnverified, cwd },
        deps,
      );
      if (args.dryRun) {
        const login = auth.state === 'logged-in' ? `${auth.method ?? 'unknown'} login` : auth.state;
        const required = ['--confirm', ...(selection.issues.length > 0 && !selection.blocked ? ['--accept-unverified'] : [])];
        io.out(
          'run plan (dry run, no agent started)\n' +
            `  provider: codex\n  cwd: ${cwd}\n  git: ${git}\n  sandbox: read-only\n  login: ${login}\n` +
            `  model: ${describePinned(selection.model)}\n  effort: ${describePinned(selection.effort)}\n` +
            `  mode: normal\n  timeout: ${String(args.timeoutMs / 1000)}s\n  task: ${String(args.task.length)} characters\n` +
            selection.issues.map((i) => `  issue: ${describeIssue(i)}\n`).join('') +
            `  requires: ${required.join(', ')}\n` +
            `  verdict: ${plan.ok ? 'would run' : `would refuse: ${REFUSALS[plan.reason]}`}\n`,
        );
        return plan.ok ? 0 : 1;
      }
      if (!plan.ok) {
        io.error(`run refused: ${REFUSALS[plan.reason]}\n${plan.issues.map((i) => `  issue: ${describeIssue(i)}\n`).join('')}`);
        return 1;
      }
      io.error(
        `running codex (read-only sandbox, subscription login) in ${cwd}\n` +
          `  model: ${describePinned(selection.model)}\n  effort: ${describePinned(selection.effort)}\n` +
          plan.warnings.map((i) => `  warning: ${describeIssue(i)}\n`).join(''),
      );
      const outcome = await runCodex(
        { task: args.task, cwd, selection, timeoutMs: args.timeoutMs, ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
        deps.runner === undefined ? {} : { runner: deps.runner },
      );
      if (outcome.kind !== 'completed') {
        io.error(`${RUN_FAILURES[outcome.kind]}\n`);
        return outcome.kind === 'cancelled' ? 130 : 1;
      }
      io.out(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
      if (outcome.truncated) io.error('output was truncated\n');
      return 0;
    }
    case 'orchestrate': {
      const args = parseOrchestrateArgs(argv.slice(1));
      if (typeof args === 'string') {
        io.error(`${args}\n`);
        return 2;
      }
      return args.workflow === 'plan-implement-review' ? runPlanImplementReviewCommand(args, io, deps) : runOrchestrateCommand(args, io, deps);
    }
    case 'outcomes': {
      if (deps.outcomes === undefined) {
        io.error('outcomes: no local store is available\n');
        return 1;
      }
      const sub = argv[1];
      if (sub === 'clear' && argv.length === 2) {
        try {
          await deps.outcomes.clear();
        } catch {
          io.error('outcomes: the store is locked or not writable; nothing was deleted (see docs/ORCHESTRATE.md)\n');
          return 1;
        }
        io.out('outcomes: all local records deleted\n');
        return 0;
      }
      if (sub !== undefined) {
        io.error('usage: outcomes [clear]\n');
        return 2;
      }
      io.out(formatOutcomes(await deps.outcomes.load(), (deps.now ?? (() => new Date()))()));
      return 0;
    }
    case 'info':
      io.out(
        `${JSON.stringify(getInfo({ node: process.version, platform: process.platform }), null, 2)}\n`,
      );
      return 0;
  }
}
