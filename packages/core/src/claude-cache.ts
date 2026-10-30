import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeQuotaStatus } from './claude-quota.ts';
import type { QuotaWindow } from './quota.ts';

export const CACHE_FILE = 'claude-quota.json';
/** Data older than this is treated as unknown. */
export const MAX_CACHE_AGE_MS = 15 * 60 * 1000;
const MAX_CACHE_BYTES = 4096;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export interface CacheEnv {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/** Per-user cache directory; `ACL_CACHE_DIR` overrides it. */
export function resolveCacheDir(
  { platform, env, home }: CacheEnv = { platform: process.platform, env: process.env, home: homedir() },
): string | undefined {
  const override = env['ACL_CACHE_DIR'];
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    return base === undefined || base === '' ? undefined : join(base, 'agent-control-lab');
  }
  if (home === '') return undefined;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'agent-control-lab');
  const xdg = env['XDG_CACHE_HOME'];
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache'), 'agent-control-lab');
}

interface StoredWindow {
  usedPercent?: number;
  resetsAt?: string;
}

function storedWindow(window: QuotaWindow | undefined): StoredWindow | undefined {
  if (window === undefined) return undefined;
  return {
    ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

/** Serialises only percentages, reset times and the update time. */
export function serializeCache(status: ClaudeQuotaStatus, now: Date): string {
  const fiveHour = storedWindow(status.fiveHour);
  const sevenDay = storedWindow(status.sevenDay);
  return JSON.stringify({
    version: 1,
    updatedAt: now.toISOString(),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isoTime(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function loadWindow(value: unknown, windowMinutes: number, now: Date): QuotaWindow | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const resets = isoTime(record['resetsAt']);
  // A window whose reset time has passed no longer describes current usage.
  if (resets !== undefined && resets.getTime() <= now.getTime()) return undefined;
  const used = record['usedPercent'];
  const hasPercent = typeof used === 'number' && Number.isFinite(used);
  if (!hasPercent && resets === undefined) return undefined;
  return {
    windowMinutes,
    ...(hasPercent ? { usedPercent: Math.min(100, Math.max(0, used)) } : {}),
    ...(resets === undefined ? {} : { resetsAt: resets.toISOString() }),
  };
}

/** Validates cache text strictly; stale, future-dated or malformed data is `unknown`. */
export function parseCache(text: string, now: Date): ClaudeQuotaStatus {
  const unknown: ClaudeQuotaStatus = { state: 'unknown' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return unknown;
  }
  const record = asRecord(data);
  const updated = isoTime(record?.['updatedAt']);
  if (record === undefined || record['version'] !== 1 || updated === undefined) return unknown;
  const age = now.getTime() - updated.getTime();
  if (age > MAX_CACHE_AGE_MS || age < -MAX_FUTURE_SKEW_MS) return unknown;
  const fiveHour = loadWindow(record['fiveHour'], 300, now);
  const sevenDay = loadWindow(record['sevenDay'], 10080, now);
  if (fiveHour === undefined && sevenDay === undefined) return unknown;
  return {
    state: 'ok',
    updatedAt: updated.toISOString(),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
  };
}

async function ensureSafeDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error('cache path is not a directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('cache directory is owned by another user');
  }
}

/** Atomically writes the cache (owner-only). Returns false when there is nothing to store. */
export async function writeClaudeCache(dir: string, status: ClaudeQuotaStatus, now: Date): Promise<boolean> {
  if (status.state !== 'ok') return false;
  await ensureSafeDir(dir);
  const target = join(dir, CACHE_FILE);
  const temp = join(dir, `.claude-quota-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, serializeCache(status, now), { flag: 'wx', mode: 0o600 });
    await rename(temp, target);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
  return true;
}

export async function readClaudeCache(dir: string, now: Date): Promise<ClaudeQuotaStatus> {
  const file = join(dir, CACHE_FILE);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) return { state: 'unknown' };
    return parseCache(await readFile(file, 'utf8'), now);
  } catch {
    return { state: 'unknown' };
  }
}
