import type { AuthStatus } from './auth.ts';
import type { ProviderQuota, QuotaProviderId } from './quota-model.ts';

export const TASK_KINDS = ['planning', 'research', 'implementation', 'refactor', 'debugging', 'review'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const ROUTE_PROVIDERS = ['claude', 'codex'] as const satisfies readonly QuotaProviderId[];
export type RouteProvider = (typeof ROUTE_PROVIDERS)[number];
export type ProviderPreference = RouteProvider | 'auto';

/** Only `available` (installed and logged in) is eligible; `unknown` is never assumed usable. */
export type Availability = 'available' | 'not-installed' | 'logged-out' | 'unknown';

export type QuotaLevel = 'ok' | 'low' | 'exhausted' | 'unknown';

export interface RoutePolicy {
  /** Preferred provider order per task kind; earlier wins ties. */
  readonly affinity: Readonly<Record<TaskKind, readonly RouteProvider[]>>;
  /** A known window at or above this percent counts as exhausted. */
  readonly exhaustedAtPercent: number;
  /** A known window at or above this percent counts as low. */
  readonly lowAtPercent: number;
}

export const defaultPolicy: RoutePolicy = {
  affinity: {
    planning: ['claude', 'codex'],
    research: ['claude', 'codex'],
    implementation: ['claude', 'codex'],
    refactor: ['claude', 'codex'],
    debugging: ['codex', 'claude'],
    review: ['codex', 'claude'],
  },
  exhaustedAtPercent: 95,
  lowAtPercent: 80,
};

export interface RouteInput {
  readonly task: TaskKind;
  readonly preference: ProviderPreference;
  readonly availability: Readonly<Record<RouteProvider, Availability>>;
  readonly quota: Readonly<Partial<Record<RouteProvider, ProviderQuota>>>;
}

export type RouteReason = 'user-preference' | 'task-affinity' | 'better-quota';
export type ManualReason =
  | 'preferred-unavailable'
  | 'preferred-quota-exhausted'
  | 'no-available-provider'
  | 'all-available-quota-exhausted';
export interface RouteCaveat {
  readonly code: 'quota-unknown' | 'quota-low';
  readonly provider: RouteProvider;
}

export type RouteDecision =
  | {
      readonly kind: 'recommend';
      readonly provider: RouteProvider;
      readonly reasons: readonly RouteReason[];
      readonly caveats: readonly RouteCaveat[];
    }
  | { readonly kind: 'manual-selection-required'; readonly reasons: readonly ManualReason[] };

/**
 * Classifies one provider's own quota. Windows are never compared across providers, and
 * anything not fully known (missing, stale, partial) is `unknown`, never zero usage.
 */
export function classifyQuota(quota: ProviderQuota | undefined, policy: RoutePolicy = defaultPolicy): QuotaLevel {
  if (quota?.state !== 'ok') return 'unknown';
  const used = quota.windows.flatMap((w) => (w.usedPercent === undefined ? [] : [w.usedPercent]));
  const max = used.length === 0 ? undefined : Math.max(...used);
  // A known-exhausted window is conclusive even if another window is unknown.
  if (max !== undefined && max >= policy.exhaustedAtPercent) return 'exhausted';
  if (max === undefined || used.length < quota.windows.length) return 'unknown';
  return max >= policy.lowAtPercent ? 'low' : 'ok';
}

/** Lower is better. Known healthy beats known low beats unknown. */
const TIER: Record<Exclude<QuotaLevel, 'exhausted'>, number> = { ok: 0, low: 1, unknown: 2 };

function caveat(provider: RouteProvider, level: QuotaLevel): RouteCaveat[] {
  if (level === 'unknown') return [{ code: 'quota-unknown', provider }];
  if (level === 'low') return [{ code: 'quota-low', provider }];
  return [];
}

/** Pure dry-run routing: recommends, never runs agents or switches providers. */
export function routeTask(input: RouteInput, policy: RoutePolicy = defaultPolicy): RouteDecision {
  const levels = Object.fromEntries(
    ROUTE_PROVIDERS.map((p) => [p, classifyQuota(input.quota[p], policy)]),
  ) as Record<RouteProvider, QuotaLevel>;
  const eligible = ROUTE_PROVIDERS.filter((p) => input.availability[p] === 'available');

  if (input.preference !== 'auto') {
    const preferred = input.preference;
    if (!eligible.includes(preferred)) {
      return { kind: 'manual-selection-required', reasons: ['preferred-unavailable'] };
    }
    if (levels[preferred] === 'exhausted') {
      return { kind: 'manual-selection-required', reasons: ['preferred-quota-exhausted'] };
    }
    return {
      kind: 'recommend',
      provider: preferred,
      reasons: ['user-preference'],
      caveats: caveat(preferred, levels[preferred]),
    };
  }

  if (eligible.length === 0) {
    return { kind: 'manual-selection-required', reasons: ['no-available-provider'] };
  }
  const usable = eligible.filter((p) => levels[p] !== 'exhausted');
  if (usable.length === 0) {
    return { kind: 'manual-selection-required', reasons: ['all-available-quota-exhausted'] };
  }
  const order = policy.affinity[input.task];
  const rank = (p: RouteProvider): number => {
    const index = order.indexOf(p);
    return index === -1 ? order.length : index;
  };
  const tier = (p: RouteProvider): number => TIER[levels[p] as Exclude<QuotaLevel, 'exhausted'>];
  const sorted = [...usable].sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b));
  const best = sorted[0];
  if (best === undefined) return { kind: 'manual-selection-required', reasons: ['no-available-provider'] };
  const runnerUp = sorted[1];
  const reasons: RouteReason[] =
    runnerUp !== undefined && tier(best) < tier(runnerUp) ? ['better-quota', 'task-affinity'] : ['task-affinity'];
  return { kind: 'recommend', provider: best, reasons, caveats: caveat(best, levels[best]) };
}

export function availabilityFromAuth(statuses: readonly AuthStatus[]): Record<RouteProvider, Availability> {
  const result: Record<RouteProvider, Availability> = { claude: 'unknown', codex: 'unknown' };
  for (const status of statuses) {
    const provider: RouteProvider | undefined =
      status.id === 'claude-code' ? 'claude' : status.id === 'codex' ? 'codex' : undefined;
    if (provider === undefined) continue;
    result[provider] =
      status.state === 'logged-in'
        ? 'available'
        : status.state === 'logged-out'
          ? 'logged-out'
          : status.state === 'not-installed'
            ? 'not-installed'
            : 'unknown';
  }
  return result;
}
