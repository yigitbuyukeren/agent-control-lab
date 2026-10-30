import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_FILE,
  MAX_CACHE_AGE_MS,
  parseCache,
  readClaudeCache,
  resolveCacheDir,
  serializeCache,
  writeClaudeCache,
} from './claude-cache.ts';
import { parseClaudeStatusLine } from './claude-quota.ts';

const NOW = new Date('2027-01-15T00:00:00Z');
const posix = process.platform !== 'win32';

const status = parseClaudeStatusLine(
  JSON.stringify({
    session_id: 'secret-session',
    oauth: { token: 'sk-secret' },
    rate_limits: {
      five_hour: { used_percentage: 12, resets_at: 1_800_000_000, email: 'me@example.com' },
      seven_day: { used_percentage: 40, resets_at: 1_800_500_000 },
    },
  }),
);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acl-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveCacheDir', () => {
  const base = { env: {}, home: '/home/u' };
  it('uses per-platform locations and the override', () => {
    expect(resolveCacheDir({ ...base, platform: 'darwin' })).toMatch(/Library.Caches.agent-control-lab$/);
    expect(resolveCacheDir({ ...base, platform: 'linux' })).toMatch(/\.cache.agent-control-lab$/);
    expect(resolveCacheDir({ ...base, platform: 'linux', env: { XDG_CACHE_HOME: '/x' } })).toMatch(/x.agent-control-lab$/);
    expect(resolveCacheDir({ ...base, platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } })).toMatch(/agent-control-lab$/);
    expect(resolveCacheDir({ ...base, platform: 'win32' })).toBeUndefined();
    expect(resolveCacheDir({ ...base, platform: 'linux', env: { ACL_CACHE_DIR: '/o' } })).toBe('/o');
  });
});

describe('cache write/read', () => {
  it('round-trips and stores only whitelisted fields', async () => {
    expect(await writeClaudeCache(dir, status, NOW)).toBe(true);
    const raw = readFileSync(join(dir, CACHE_FILE), 'utf8');
    expect(raw).not.toMatch(/secret|example|session|oauth|token/);
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['fiveHour', 'sevenDay', 'updatedAt', 'version']);
    const read = await readClaudeCache(dir, new Date(NOW.getTime() + 60_000));
    expect(read).toMatchObject({
      state: 'ok',
      updatedAt: NOW.toISOString(),
      fiveHour: { usedPercent: 12, windowMinutes: 300 },
      sevenDay: { usedPercent: 40 },
    });
  });

  it('leaves no temp files and does not store unknown input', async () => {
    await writeClaudeCache(dir, status, NOW);
    expect(readdirSync(dir)).toEqual([CACHE_FILE]);
    expect(await writeClaudeCache(dir, { state: 'unknown' }, NOW)).toBe(false);
    expect(await readClaudeCache(dir, NOW)).toMatchObject({ state: 'ok' });
  });

  it.runIf(posix)('creates owner-only directory and file', async () => {
    const nested = join(dir, 'a', 'b');
    await writeClaudeCache(nested, status, NOW);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(join(nested, CACHE_FILE)).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('refuses a symlinked cache file and a non-directory cache path', async () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, serializeCache(status, NOW));
    const linkDir = join(dir, 'link');
    await writeClaudeCache(linkDir, status, NOW);
    rmSync(join(linkDir, CACHE_FILE));
    symlinkSync(real, join(linkDir, CACHE_FILE));
    expect(await readClaudeCache(linkDir, NOW)).toEqual({ state: 'unknown' });
    const file = join(dir, 'plain');
    writeFileSync(file, 'x');
    await expect(writeClaudeCache(file, status, NOW)).rejects.toThrow();
  });
});

describe('parseCache', () => {
  const fresh = serializeCache(status, NOW);
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it('is unknown when stale, future-dated or missing', () => {
    expect(parseCache(fresh, later(MAX_CACHE_AGE_MS + 1))).toEqual({
      state: 'unknown',
      updatedAt: NOW.toISOString(),
    });
    expect(parseCache(fresh, later(-10 * 60_000))).toEqual({ state: 'unknown' });
    expect(parseCache('', NOW)).toEqual({ state: 'unknown' });
  });

  it('is unknown for malformed or tampered content', () => {
    for (const text of [
      'nope',
      '[]',
      '{"version":2,"updatedAt":"2027-01-15T00:00:00Z","fiveHour":{"usedPercent":1}}',
      '{"version":1,"fiveHour":{"usedPercent":1}}',
      '{"version":1,"updatedAt":"yesterday","fiveHour":{"usedPercent":1}}',
      '{"version":1,"updatedAt":"2027-01-15T00:00:00Z"}',
    ]) {
      expect(parseCache(text, NOW)).toEqual({ state: 'unknown' });
    }
  });

  it('drops extra keys, clamps values and ignores windows that already reset', () => {
    const text = JSON.stringify({
      version: 1,
      updatedAt: NOW.toISOString(),
      token: 'sk-secret',
      fiveHour: { usedPercent: 500, resetsAt: '2027-01-15T01:00:00Z', email: 'me@example.com' },
      sevenDay: { usedPercent: 10, resetsAt: '2027-01-14T23:59:00Z' },
    });
    const parsed = parseCache(text, NOW);
    expect(parsed).toEqual({
      state: 'ok',
      updatedAt: NOW.toISOString(),
      fiveHour: { windowMinutes: 300, usedPercent: 100, resetsAt: '2027-01-15T01:00:00.000Z' },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|example/);
  });

  it('rejects oversized files on read', async () => {
    writeFileSync(join(dir, CACHE_FILE), ' '.repeat(5000) + fresh);
    expect(await readClaudeCache(dir, NOW)).toEqual({ state: 'unknown' });
  });
});
