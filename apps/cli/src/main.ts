import {
  builtinAdapters,
  defaultExec,
  detectAuthStatuses,
  detectProviders,
  getInfo,
  parseClaudeStatusLine,
  parseCommand,
  ROUTE_PROVIDERS,
  TASK_KINDS,
  availabilityFromAuth,
  readAllQuotas,
  routeTask,
  readClaudeCache,
  readCodexQuota,
  resolveCacheDir,
  writeClaudeCache,
  type AppServerSpawn,
  type AuthStatus,
  type ClaudeQuotaStatus,
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
  route --dry-run --task <kind> [--prefer claude|codex|auto]
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
}

function parseRouteArgs(args: readonly string[]): RouteArgs | string {
  let task: TaskKind | undefined;
  let preference: ProviderPreference = 'auto';
  let dryRun = false;
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
    } else {
      return `unknown route option: ${arg ?? ''}`;
    }
  }
  if (!dryRun) return 'route only supports --dry-run; nothing is executed';
  if (task === undefined) return `--task is required (${TASK_KINDS.join(', ')})`;
  return { task, preference };
}

function formatRoute(args: RouteArgs, decision: RouteDecision): string {
  const head = `route (dry run): task=${args.task} prefer=${args.preference}\n`;
  if (decision.kind === 'manual-selection-required') {
    return `${head}manual-selection-required\n${decision.reasons.map((r) => `  reason: ${r}\n`).join('')}`;
  }
  return (
    `${head}recommended: ${decision.provider}\n` +
    decision.reasons.map((r) => `  reason: ${r}\n`).join('') +
    decision.caveats.map((c) => `  caveat: ${c.code} (${c.provider})\n`).join('')
  );
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
      io.out(formatRoute(args, decision));
      return 0;
    }
    case 'info':
      io.out(
        `${JSON.stringify(getInfo({ node: process.version, platform: process.platform }), null, 2)}\n`,
      );
      return 0;
  }
}
