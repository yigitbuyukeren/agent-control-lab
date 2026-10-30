import { readClaudeCache } from './claude-cache.ts';
import type { ClaudeQuotaStatus } from './claude-quota.ts';
import { readCodexQuota, type AppServerSpawn, type QuotaStatus, type QuotaWindow } from './quota.ts';

export type QuotaProviderId = 'claude' | 'codex';
export type QuotaSource = 'cache' | 'live';
/** `unknown` means nothing is known about the data's age; it never implies zero usage. */
export type Freshness = 'live' | 'fresh' | 'stale' | 'unknown';

export interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly windowMinutes?: number;
  /** Absent when unknown: never defaulted to 0. */
  readonly usedPercent?: number;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}

export interface ProviderQuota {
  readonly provider: QuotaProviderId;
  readonly displayName: string;
  readonly state: 'ok' | 'unknown' | 'not-installed' | 'error';
  readonly source: QuotaSource;
  readonly freshness: Freshness;
  readonly plan?: string;
  /** ISO time the data was collected. */
  readonly updatedAt?: string;
  readonly windows: readonly UsageWindow[];
  readonly error?: string;
}

export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes % 1440 === 0) return `${String(minutes / 1440)}d`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`;
  return `${String(minutes)}m`;
}

function toUsageWindow(id: string, fallbackLabel: string, window: QuotaWindow | undefined): UsageWindow {
  const used = window?.usedPercent;
  return {
    id,
    label: windowLabel(window?.windowMinutes, fallbackLabel),
    ...(window?.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
    ...(used === undefined ? {} : { usedPercent: used, remainingPercent: Math.round((100 - used) * 100) / 100 }),
    ...(window?.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

export function fromClaudeCache(status: ClaudeQuotaStatus): ProviderQuota {
  const fiveHour = status.fiveHour === undefined ? undefined : { ...status.fiveHour, windowMinutes: 300 };
  const sevenDay = status.sevenDay === undefined ? undefined : { ...status.sevenDay, windowMinutes: 10080 };
  const freshness: Freshness = status.state === 'ok' ? 'fresh' : status.updatedAt === undefined ? 'unknown' : 'stale';
  return {
    provider: 'claude',
    displayName: 'Claude Code',
    state: status.state,
    source: 'cache',
    freshness,
    ...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
    windows: [
      toUsageWindow('five_hour', '5h', fiveHour ?? { windowMinutes: 300 }),
      toUsageWindow('seven_day', '7d', sevenDay ?? { windowMinutes: 10080 }),
    ],
  };
}

export function fromCodexQuota(status: QuotaStatus, now: Date): ProviderQuota {
  const base = { provider: 'codex', displayName: 'Codex', source: 'live' } as const;
  if (status.state === 'not-installed') {
    return { ...base, state: 'not-installed', freshness: 'unknown', windows: [] };
  }
  if (status.state === 'error') {
    return { ...base, state: 'error', freshness: 'unknown', windows: [], error: status.error ?? 'unknown' };
  }
  // Windows present but carrying no usable value (e.g. `{}`) are not data.
  const hasData = [status.primary, status.secondary].some(
    (window) => window?.usedPercent !== undefined || window?.resetsAt !== undefined,
  );
  return {
    ...base,
    state: hasData ? 'ok' : 'unknown',
    freshness: hasData ? 'live' : 'unknown',
    ...(hasData ? { updatedAt: now.toISOString() } : {}),
    ...(status.plan === undefined ? {} : { plan: status.plan }),
    windows: [
      toUsageWindow('primary', 'primary', status.primary),
      toUsageWindow('secondary', 'secondary', status.secondary),
    ],
  };
}

export interface AllQuotaOptions {
  /** Claude statusLine cache directory; undefined means no cache is available. */
  readonly claudeCacheDir: string | undefined;
  readonly appServer?: AppServerSpawn;
  readonly now?: () => Date;
}

/** Reads the local Claude cache and Codex's app-server quota side by side; no model calls. */
export async function readAllQuotas(options: AllQuotaOptions): Promise<ProviderQuota[]> {
  const now = options.now ?? (() => new Date());
  const [claude, codex] = await Promise.all([
    options.claudeCacheDir === undefined
      ? Promise.resolve<ClaudeQuotaStatus>({ state: 'unknown' })
      : readClaudeCache(options.claudeCacheDir, now()),
    readCodexQuota(options.appServer),
  ]);
  return [fromClaudeCache(claude), fromCodexQuota(codex, now())];
}
