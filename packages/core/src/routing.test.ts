import { describe, expect, it } from 'vitest';
import type { AuthStatus } from './auth.ts';
import type { ProviderQuota } from './quota-model.ts';
import {
  availabilityFromAuth,
  classifyQuota,
  defaultPolicy,
  routeTask,
  type Availability,
  type RouteInput,
  type RoutePolicy,
  type RouteProvider,
  type TaskKind,
} from './routing.ts';

/** Builds a quota; `null` means a window whose usage is unknown. */
function quota(provider: RouteProvider, used: (number | null)[], state: ProviderQuota['state'] = 'ok'): ProviderQuota {
  return {
    provider,
    displayName: provider,
    state,
    source: 'live',
    freshness: 'live',
    windows: used.map((u, i) => ({
      id: `w${String(i)}`,
      label: `w${String(i)}`,
      ...(u === null ? {} : { usedPercent: u, remainingPercent: 100 - u }),
    })),
  };
}

function input(overrides: Partial<RouteInput> & { task?: TaskKind } = {}): RouteInput {
  return {
    task: 'implementation',
    preference: 'auto',
    availability: { claude: 'available', codex: 'available' },
    quota: { claude: quota('claude', [10, 10]), codex: quota('codex', [10, 10]) },
    ...overrides,
  };
}

const both = (a: Availability, b: Availability) => ({ claude: a, codex: b });

describe('classifyQuota', () => {
  it('uses inclusive thresholds', () => {
    expect(classifyQuota(quota('codex', [79.99]))).toBe('ok');
    expect(classifyQuota(quota('codex', [80]))).toBe('low');
    expect(classifyQuota(quota('codex', [94.99]))).toBe('low');
    expect(classifyQuota(quota('codex', [95]))).toBe('exhausted');
  });
  it('treats real 0% as ok but missing, partial, stale or absent data as unknown', () => {
    expect(classifyQuota(quota('codex', [0, 0]))).toBe('ok');
    expect(classifyQuota(quota('codex', [null, null]))).toBe('unknown');
    expect(classifyQuota(quota('codex', [10, null]))).toBe('unknown');
    expect(classifyQuota(quota('codex', [], 'ok'))).toBe('unknown');
    expect(classifyQuota(quota('codex', [10], 'unknown'))).toBe('unknown');
    expect(classifyQuota(undefined)).toBe('unknown');
  });
  it('lets a known exhausted window win over an unknown one', () => {
    expect(classifyQuota(quota('codex', [99, null]))).toBe('exhausted');
  });
});

describe('routeTask: auto', () => {
  it('follows task affinity when both are healthy', () => {
    expect(routeTask(input({ task: 'review' }))).toMatchObject({ kind: 'recommend', provider: 'codex', reasons: ['task-affinity'] });
    expect(routeTask(input({ task: 'planning' }))).toMatchObject({ provider: 'claude' });
  });

  it('does not compare percentages across providers', () => {
    const decision = routeTask(
      input({ task: 'review', quota: { claude: quota('claude', [1, 1]), codex: quota('codex', [79, 79]) } }),
    );
    expect(decision).toMatchObject({ provider: 'codex' });
  });

  it('prefers known-ok over low over unknown, whatever the affinity', () => {
    const okVsLow = routeTask(
      input({ task: 'review', quota: { claude: quota('claude', [10]), codex: quota('codex', [85]) } }),
    );
    expect(okVsLow).toMatchObject({ provider: 'claude', reasons: ['better-quota', 'task-affinity'] });
    const lowVsUnknown = routeTask(
      input({ task: 'planning', quota: { claude: quota('claude', [null]), codex: quota('codex', [85]) } }),
    );
    expect(lowVsUnknown).toMatchObject({ provider: 'codex', caveats: [{ code: 'quota-low', provider: 'codex' }] });
  });

  it('never counts unknown quota as zero', () => {
    const decision = routeTask(
      input({ task: 'planning', quota: { codex: quota('codex', [30]) } }),
    );
    expect(decision).toMatchObject({ provider: 'codex' });
  });

  it('still recommends with a caveat when everything is unknown', () => {
    expect(routeTask(input({ task: 'debugging', quota: {} }))).toEqual({
      kind: 'recommend',
      provider: 'codex',
      reasons: ['task-affinity'],
      caveats: [{ code: 'quota-unknown', provider: 'codex' }],
    });
  });

  it('skips exhausted providers and ignores unavailable ones', () => {
    expect(
      routeTask(input({ task: 'review', quota: { claude: quota('claude', [5]), codex: quota('codex', [96]) } })),
    ).toMatchObject({ provider: 'claude' });
    expect(routeTask(input({ task: 'planning', availability: both('logged-out', 'available') }))).toMatchObject({
      provider: 'codex',
    });
  });

  it('requires manual selection when nothing usable remains', () => {
    expect(routeTask(input({ availability: both('not-installed', 'logged-out') }))).toEqual({
      kind: 'manual-selection-required',
      reasons: ['no-available-provider'],
    });
    expect(routeTask(input({ availability: both('unknown', 'unknown') }))).toMatchObject({
      kind: 'manual-selection-required',
    });
    expect(
      routeTask(input({ quota: { claude: quota('claude', [99]), codex: quota('codex', [100]) } })),
    ).toEqual({ kind: 'manual-selection-required', reasons: ['all-available-quota-exhausted'] });
  });
});

describe('routeTask: user preference', () => {
  it('honours the preference even against affinity and better quota elsewhere', () => {
    const decision = routeTask(
      input({ task: 'review', preference: 'claude', quota: { claude: quota('claude', [70]), codex: quota('codex', [1]) } }),
    );
    expect(decision).toEqual({ kind: 'recommend', provider: 'claude', reasons: ['user-preference'], caveats: [] });
  });

  it('never switches automatically when the preferred provider is unusable', () => {
    expect(routeTask(input({ preference: 'codex', availability: both('available', 'logged-out') }))).toEqual({
      kind: 'manual-selection-required',
      reasons: ['preferred-unavailable'],
    });
    expect(
      routeTask(input({ preference: 'codex', quota: { claude: quota('claude', [1]), codex: quota('codex', [97]) } })),
    ).toEqual({ kind: 'manual-selection-required', reasons: ['preferred-quota-exhausted'] });
  });

  it('adds a caveat for unknown or low quota on the preferred provider', () => {
    expect(routeTask(input({ preference: 'claude', quota: {} }))).toMatchObject({
      caveats: [{ code: 'quota-unknown', provider: 'claude' }],
    });
    expect(routeTask(input({ preference: 'claude', quota: { claude: quota('claude', [85]) } }))).toMatchObject({
      caveats: [{ code: 'quota-low', provider: 'claude' }],
    });
  });
});

describe('routeTask: purity and policy', () => {
  it('does not mutate frozen input and is deterministic', () => {
    const frozen = Object.freeze(input({ task: 'review' }));
    expect(routeTask(frozen)).toEqual(routeTask(frozen));
  });

  it('accepts a custom policy', () => {
    const policy: RoutePolicy = { ...defaultPolicy, affinity: { ...defaultPolicy.affinity, review: ['claude', 'codex'] }, exhaustedAtPercent: 50 };
    expect(routeTask(input({ task: 'review' }), policy)).toMatchObject({ provider: 'claude' });
    expect(routeTask(input({ quota: { claude: quota('claude', [60]), codex: quota('codex', [60]) } }), policy)).toMatchObject({
      kind: 'manual-selection-required',
    });
  });
});

describe('availabilityFromAuth', () => {
  const status = (id: string, state: AuthStatus['state']): AuthStatus => ({ id, displayName: id, state });
  it('maps auth states and defaults missing providers to unknown', () => {
    expect(availabilityFromAuth([status('claude-code', 'logged-in'), status('codex', 'error')])).toEqual({
      claude: 'available',
      codex: 'unknown',
    });
    expect(availabilityFromAuth([status('codex', 'logged-out'), status('other', 'logged-in')])).toEqual({
      claude: 'unknown',
      codex: 'logged-out',
    });
    expect(availabilityFromAuth([status('codex', 'not-installed')]).codex).toBe('not-installed');
  });
});
