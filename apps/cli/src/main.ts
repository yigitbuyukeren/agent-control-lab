import {
  builtinAdapters,
  defaultExec,
  detectAuthStatuses,
  detectProviders,
  getInfo,
  parseClaudeStatusLine,
  parseCommand,
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_REQUEST,
  ROUTE_PROVIDERS,
  TASK_KINDS,
  asEffortLevel,
  availabilityFromAuth,
  checkEffort,
  claudeRegistry,
  discoverCodexModels,
  isDefaultRequest,
  readAllQuotas,
  resolveSelection,
  routeTask,
  readClaudeCache,
  readCodexQuota,
  resolveCacheDir,
  writeClaudeCache,
  type AppServerSpawn,
  type AuthStatus,
  type ClaudeQuotaStatus,
  type CodexModelsResult,
  type EffortCheck,
  type ModelCapability,
  type Selection,
  type SelectionIssue,
  type SelectionRequest,
  type Pinned,
  type ProviderPreference,
  type ProviderQuota,
  type RouteDecision,
  type TaskKind,
  type UsageWindow,
  type Exec,
  type ProviderStatus,
  type QuotaStatus,
  type QuotaWindow,
} from '@agent-control-lab/core';
import { VERSION } from '@agent-control-lab/shared';

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
  models                List known models and efforts (Claude: documented, unverified; Codex: discovered)
  models check <claude|codex> <model> <effort>
                        Exit 0 supported, 1 unsupported, 3 unknown
  route --dry-run --task <kind> [--prefer claude|codex|auto] [--model auto|<id>] [--effort auto|<level>] [--mode normal|ultracode]
                        Recommend a provider (no agent is started)
  statusline-collect    Store 5h/7d limits from statusLine JSON on stdin (opt-in, see docs/STATUSLINE.md)
  auth-status Show provider login state and method (local status commands only)
`;

export interface Io {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface Deps {
  readonly exec?: Exec;
  readonly appServer?: AppServerSpawn;
  readonly readStdin?: () => Promise<string>;
  readonly cacheDir?: string;
  readonly now?: () => Date;
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

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

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
      if (value === undefined || !MODEL_ID_PATTERN.test(value)) return '--model must be auto or a model id';
      model = value;
    } else if (arg === '--effort') {
      const value = args[(i += 1)];
      if (value === 'ultracode') return 'ultracode is a work mode, not an effort: use --mode ultracode';
      if (value !== 'auto' && (value === undefined || asEffortLevel(value) === undefined)) {
        return '--effort must be auto or a level such as low, medium, high, xhigh, max, ultra';
      }
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

function describePinned(pinned: Pinned): string {
  if (pinned.kind === 'provider-default') return 'provider-default';
  return `${pinned.value} (${pinned.verified ? 'verified' : 'unverified'})`;
}

function describeIssue(issue: SelectionIssue): string {
  const flag = issue.blocking ? 'blocking' : 'unverified';
  switch (issue.code) {
    case 'model-not-listed':
      return `model-not-listed [${flag}] ${issue.model}`;
    case 'model-discovery-failed':
      return `model-discovery-failed [${flag}] ${issue.model} (${issue.reason}${issue.error === undefined ? '' : `: ${issue.error}`})`;
    case 'model-access-unverified':
      return `model-access-unverified [${flag}] ${issue.model} (${issue.documented ? 'documented' : 'not documented'})`;
    case 'effort-invalid':
      return `effort-invalid [${flag}] ${issue.effort}`;
    case 'effort-unsupported':
      return `effort-unsupported [${flag}] ${issue.effort} (supported: ${issue.supported.join(', ')})`;
    case 'effort-unverified':
      return `effort-unverified [${flag}] ${issue.effort} (${issue.reason})`;
    case 'mode-unsupported':
      return `mode-unsupported [${flag}] ${issue.mode}`;
    case 'mode-unverified':
      return `mode-unverified [${flag}] ${issue.mode}`;
  }
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
      // Silent on stdout: the statusLine command's output would otherwise become the status text.
      const status = parseClaudeStatusLine(await (deps.readStdin ?? readProcessStdin)());
      const dir = deps.cacheDir ?? resolveCacheDir();
      if (status.state !== 'ok' || dir === undefined) return 0;
      try {
        await writeClaudeCache(dir, status, (deps.now ?? (() => new Date()))());
      } catch {
        io.error('could not write the quota cache\n');
        return 1;
      }
      return 0;
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
      if (sub !== 'check' || (provider !== 'claude' && provider !== 'codex') || modelId === undefined || effort === undefined) {
        io.error('usage: agent-control-lab models [check <claude|codex> <model> <effort>]\n');
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
    case 'info':
      io.out(
        `${JSON.stringify(getInfo({ node: process.version, platform: process.platform }), null, 2)}\n`,
      );
      return 0;
  }
}
