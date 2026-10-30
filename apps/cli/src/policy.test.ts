import { describe, expect, it } from 'vitest';
import type { ProviderQuota } from '@agent-control-lab/core';
import { reliableQuota } from './policy.ts';

const quota = (over: Partial<ProviderQuota>): ProviderQuota => ({
  provider: 'codex',
  displayName: 'Codex',
  state: 'ok',
  source: 'live',
  freshness: 'live',
  windows: [{ id: 'primary', label: '5h', usedPercent: 85 }],
  ...over,
});

describe('reliableQuota', () => {
  it('uses fresh or live complete readings', () => {
    expect(reliableQuota(quota({}))).toBe('low');
    expect(reliableQuota(quota({ freshness: 'fresh', windows: [{ id: 'a', label: 'a', usedPercent: 97 }] }))).toBe('critical');
    expect(reliableQuota(quota({ windows: [{ id: 'a', label: 'a', usedPercent: 10 }] }))).toBe('ok');
  });

  it('treats stale, partial, failed or missing data as unknown, never as healthy', () => {
    expect(reliableQuota(quota({ freshness: 'stale' }))).toBe('unknown');
    expect(reliableQuota(quota({ freshness: 'unknown' }))).toBe('unknown');
    expect(reliableQuota(quota({ state: 'error' }))).toBe('unknown');
    expect(reliableQuota(quota({ windows: [{ id: 'a', label: 'a', usedPercent: 10 }, { id: 'b', label: 'b' }] }))).toBe('unknown');
    expect(reliableQuota(undefined)).toBe('unknown');
  });
});
