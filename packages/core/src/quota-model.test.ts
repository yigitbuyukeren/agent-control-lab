import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeClaudeCache } from './claude-cache.ts';
import { parseClaudeStatusLine } from './claude-quota.ts';
import { fromClaudeCache, fromCodexQuota, readAllQuotas, windowLabel } from './quota-model.ts';
import type { AppServerProcess, AppServerSpawn } from './quota.ts';

const NOW = new Date('2027-01-15T00:00:00Z');

describe('windowLabel', () => {
  it('formats minutes, hours and days', () => {
    expect(windowLabel(45, 'x')).toBe('45m');
    expect(windowLabel(300, 'x')).toBe('5h');
    expect(windowLabel(10080, 'x')).toBe('7d');
    expect(windowLabel(undefined, 'primary')).toBe('primary');
  });
});

describe('fromClaudeCache', () => {
  it('computes remaining percent and keeps freshness', () => {
    const quota = fromClaudeCache({
      state: 'ok',
      updatedAt: NOW.toISOString(),
      fiveHour: { windowMinutes: 300, usedPercent: 12.5, resetsAt: '2027-01-15T04:00:00.000Z' },
    });
    expect(quota).toMatchObject({ provider: 'claude', state: 'ok', source: 'cache', freshness: 'fresh' });
    expect(quota.windows[0]).toEqual({
      id: 'five_hour',
      label: '5h',
      windowMinutes: 300,
      usedPercent: 12.5,
      remainingPercent: 87.5,
      resetsAt: '2027-01-15T04:00:00.000Z',
    });
  });

  it('never turns missing or stale data into 0', () => {
    for (const status of [{ state: 'unknown' as const }, { state: 'unknown' as const, updatedAt: NOW.toISOString() }]) {
      const quota = fromClaudeCache(status);
      expect(quota.state).toBe('unknown');
      for (const w of quota.windows) {
        expect(w.usedPercent).toBeUndefined();
        expect(w.remainingPercent).toBeUndefined();
      }
    }
    expect(fromClaudeCache({ state: 'unknown', updatedAt: NOW.toISOString() }).freshness).toBe('stale');
    expect(fromClaudeCache({ state: 'unknown' }).freshness).toBe('unknown');
  });

  it('keeps a real 0% distinct from unknown', () => {
    const quota = fromClaudeCache({ state: 'ok', fiveHour: { windowMinutes: 300, usedPercent: 0 } });
    expect(quota.windows[0]).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
    expect(quota.windows[1]?.usedPercent).toBeUndefined();
  });
});

describe('fromCodexQuota', () => {
  it('maps live data with plan and update time', () => {
    const quota = fromCodexQuota(
      { state: 'ok', plan: 'pro', primary: { usedPercent: 30, windowMinutes: 300 }, secondary: {} },
      NOW,
    );
    expect(quota).toMatchObject({ state: 'ok', freshness: 'live', plan: 'pro', updatedAt: NOW.toISOString() });
    expect(quota.windows[0]).toMatchObject({ label: '5h', usedPercent: 30, remainingPercent: 70 });
    expect(quota.windows[1]).toEqual({ id: 'secondary', label: 'secondary' });
  });

  it('does not report empty windows as ok/live', () => {
    for (const status of [
      { state: 'ok' as const, primary: {}, secondary: {} },
      { state: 'ok' as const, plan: 'pro', primary: { windowMinutes: 300 } },
    ]) {
      const quota = fromCodexQuota(status, NOW);
      expect(quota).toMatchObject({ state: 'unknown', freshness: 'unknown' });
      expect(quota.updatedAt).toBeUndefined();
      expect(quota.windows.every((w) => w.usedPercent === undefined)).toBe(true);
    }
    expect(fromCodexQuota({ state: 'ok', primary: { resetsAt: '2027-01-15T04:00:00.000Z' } }, NOW).state).toBe('ok');
  });

  it('maps empty, not-installed and error without inventing numbers', () => {
    expect(fromCodexQuota({ state: 'ok' }, NOW)).toMatchObject({ state: 'unknown', freshness: 'unknown' });
    expect(fromCodexQuota({ state: 'not-installed' }, NOW)).toMatchObject({ state: 'not-installed', windows: [] });
    expect(fromCodexQuota({ state: 'error', error: 'timed out' }, NOW)).toMatchObject({
      state: 'error',
      error: 'timed out',
      windows: [],
    });
  });
});

function fakeAppServer(result: unknown): AppServerSpawn {
  return () => {
    let lineCb: (line: string) => void = () => undefined;
    const proc: AppServerProcess = {
      send(line) {
        const m = JSON.parse(line) as { id?: number };
        if (m.id === 1) queueMicrotask(() => { lineCb('{"id":1,"result":{}}'); });
        if (m.id === 2) queueMicrotask(() => { lineCb(JSON.stringify({ id: 2, result })); });
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    };
    return proc;
  };
}

describe('readAllQuotas', () => {
  it('combines the Claude cache and Codex app-server data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-all-'));
    try {
      const status = parseClaudeStatusLine(
        JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: 1_800_000_000 } } }),
      );
      await writeClaudeCache(dir, status, NOW);
      const quotas = await readAllQuotas({
        claudeCacheDir: dir,
        now: () => NOW,
        appServer: fakeAppServer({
          rateLimits: { planType: 'plus', primary: { usedPercent: 5, windowDurationMins: 300 } },
        }),
      });
      expect(quotas.map((q) => [q.provider, q.state])).toEqual([
        ['claude', 'ok'],
        ['codex', 'ok'],
      ]);
      expect(quotas[0]?.windows[0]).toMatchObject({ usedPercent: 20, remainingPercent: 80 });
      expect(quotas[0]?.windows[1]?.usedPercent).toBeUndefined();
      expect(quotas[1]).toMatchObject({ plan: 'plus', freshness: 'live' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports each provider independently when one is unavailable', async () => {
    const missing: AppServerSpawn = () => {
      let exit: (e: { notFound: boolean }) => void = () => undefined;
      return {
        send: () => { queueMicrotask(() => { exit({ notFound: true }); }); },
        onLine: () => undefined,
        onExit: (cb) => (exit = cb),
        kill: () => Promise.resolve(),
      };
    };
    const quotas = await readAllQuotas({ claudeCacheDir: undefined, now: () => NOW, appServer: missing });
    expect(quotas[0]).toMatchObject({ provider: 'claude', state: 'unknown', freshness: 'unknown' });
    expect(quotas[1]).toMatchObject({ provider: 'codex', state: 'not-installed' });
  });
});
