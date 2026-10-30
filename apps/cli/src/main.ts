import {
  builtinAdapters,
  defaultExec,
  detectAuthStatuses,
  detectProviders,
  getInfo,
  parseCommand,
  readCodexQuota,
  type AppServerSpawn,
  type AuthStatus,
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
  auth-status Show provider login state and method (local status commands only)
`;

export interface Io {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface Deps {
  readonly exec?: Exec;
  readonly appServer?: AppServerSpawn;
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
      const quota = await readCodexQuota(deps.appServer);
      io.out(formatQuota(quota));
      return 0;
    }
    case 'info':
      io.out(
        `${JSON.stringify(getInfo({ node: process.version, platform: process.platform }), null, 2)}\n`,
      );
      return 0;
  }
}
