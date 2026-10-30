import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CACHE_FILE, MAX_CACHE_AGE_MS, readClaudeCache } from './claude-cache.ts';
import type { QuotaWindow } from './quota.ts';

/** Where the opt-in quota collector is wired in, and why quota data is or is not there. Only Claude Code's own statusLine input is ever used. */

export const INSTALL_RECORD = 'claude-statusline-install.json';
export const SETTINGS_BACKUP = 'claude-settings-backup.json';
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_CHAIN_CHARS = 8192;

export type SettingsState = 'missing' | 'no-statusline' | 'collector' | 'chained' | 'other' | 'unsupported' | 'invalid' | 'unreadable';
export type CacheState = 'fresh' | 'missing' | 'stale' | 'expired' | 'invalid' | 'no-dir';
export type QuotaReason =
  | 'fresh'
  | 'no-cache-dir'
  | 'settings-invalid'
  | 'settings-unreadable'
  | 'not-installed'
  | 'other-statusline'
  | 'unsupported-statusline'
  | 'waiting-for-data'
  | 'stale'
  | 'windows-expired'
  | 'cache-invalid';

export interface IntegrationPlan {
  readonly action: 'add' | 'chain';
  /** The exact statusLine command that would be written. */
  readonly command: string;
}

export interface IntegrationDiagnosis {
  readonly settingsPath: string;
  readonly settings: SettingsState;
  readonly cache: { readonly state: CacheState; readonly updatedAt?: string; readonly ageSeconds?: number };
  readonly fiveHour?: QuotaWindow;
  readonly sevenDay?: QuotaWindow;
  readonly reason: QuotaReason;
  /** The collector (directly or chained) is in the user's statusLine. */
  readonly installed: boolean;
  /** An install made by this tool that can be undone. */
  readonly restorable: boolean;
  readonly plan?: IntegrationPlan;
  /** Why no install plan exists, when it does not. */
  readonly planBlocked?: 'unavailable' | 'invalid' | 'unsupported' | 'unreadable' | 'already-installed' | 'no-cache-dir';
}

export interface IntegrationPaths {
  readonly settingsPath: string;
  readonly cacheDir: string | undefined;
  /** Absolute node and entry script; the collector command is built from them. */
  readonly nodePath: string;
  readonly binPath: string;
}

export function claudeSettingsPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return join(dir !== undefined && dir !== '' ? dir : join(home, '.claude'), 'settings.json');
}

const UNSAFE_PATH = /["$`%!\n\r\0]/;

const forShell = (path: string): string => path.replace(/\\/g, '/');

/** The command Claude Code's statusLine runs; undefined when a path holds characters that cannot be quoted safely. */
export function collectorCommand(nodePath: string, binPath: string, chained?: string): string | undefined {
  if (UNSAFE_PATH.test(nodePath) || UNSAFE_PATH.test(binPath)) return undefined;
  const base = `"${forShell(nodePath)}" "${forShell(binPath)}" statusline-collect`;
  if (chained === undefined) return base;
  if (chained === '' || chained.length > MAX_CHAIN_CHARS || chained.includes('\0')) return undefined;
  return `${base} --chain ${Buffer.from(chained, 'utf8').toString('base64url')}`;
}

/** Decodes the `--chain` argument back into the user's original statusLine command. */
export function decodeChain(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,12000}$/.test(value)) return undefined;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  return text === '' || text.length > MAX_CHAIN_CHARS || text.includes('\0') ? undefined : text;
}

type Loaded =
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' | 'invalid' }
  | { readonly state: 'ok'; readonly text: string; readonly data: Record<string, unknown> };

async function loadSettings(path: string): Promise<Loaded> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return { state: 'unreadable' };
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { state: 'unreadable' };
  }
  try {
    const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? { state: 'ok', text, data: data as Record<string, unknown> } : { state: 'invalid' };
  } catch {
    // Comments or trailing commas: this tool never rewrites a file it cannot parse exactly.
    return { state: 'invalid' };
  }
}

function classify(statusLine: unknown): SettingsState {
  if (statusLine === undefined) return 'no-statusline';
  const record = typeof statusLine === 'object' && statusLine !== null ? (statusLine as Record<string, unknown>) : undefined;
  const command = record?.['type'] === 'command' ? record['command'] : undefined;
  if (typeof command !== 'string') return 'unsupported';
  if (/statusline-collect(\s|$)/.test(command)) return /\s--chain\s/.test(command) ? 'chained' : 'collector';
  return 'other';
}

async function cacheState(dir: string | undefined, now: Date): Promise<IntegrationDiagnosis['cache'] & { status?: Awaited<ReturnType<typeof readClaudeCache>> }> {
  if (dir === undefined) return { state: 'no-dir' };
  const file = join(dir, CACHE_FILE);
  let raw: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096) return { state: 'invalid' };
    raw = await readFile(file, 'utf8');
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' };
  }
  let updated: Date | undefined;
  try {
    const value = (JSON.parse(raw) as { updatedAt?: unknown }).updatedAt;
    updated = typeof value === 'string' ? new Date(value) : undefined;
  } catch {
    return { state: 'invalid' };
  }
  if (updated === undefined || Number.isNaN(updated.getTime())) return { state: 'invalid' };
  const age = Math.round((now.getTime() - updated.getTime()) / 1000);
  const base = { updatedAt: updated.toISOString(), ageSeconds: age };
  const status = await readClaudeCache(dir, now);
  if (status.state === 'ok') return { state: 'fresh', ...base, status };
  if (age * 1000 > MAX_CACHE_AGE_MS) return { state: 'stale', ...base };
  if (age < -60) return { state: 'invalid' };
  return { state: 'expired', ...base };
}

export async function diagnoseClaudeIntegration(paths: IntegrationPaths, now: Date): Promise<IntegrationDiagnosis> {
  const loaded = await loadSettings(paths.settingsPath);
  const settings: SettingsState = loaded.state === 'ok' ? classify(loaded.data['statusLine']) : loaded.state === 'missing' ? 'missing' : loaded.state;
  const cache = await cacheState(paths.cacheDir, now);
  const record = paths.cacheDir === undefined ? undefined : await readRecord(paths.cacheDir);
  const installed = settings === 'collector' || settings === 'chained';
  const restorable = installed && record !== undefined && record.settingsPath === paths.settingsPath;

  let reason: QuotaReason;
  if (cache.state === 'fresh') reason = 'fresh';
  else if (cache.state === 'no-dir') reason = 'no-cache-dir';
  else if (cache.state === 'stale') reason = 'stale';
  else if (cache.state === 'expired') reason = 'windows-expired';
  else if (cache.state === 'invalid') reason = 'cache-invalid';
  else if (installed) reason = 'waiting-for-data';
  else if (settings === 'invalid') reason = 'settings-invalid';
  else if (settings === 'unreadable') reason = 'settings-unreadable';
  else if (settings === 'other') reason = 'other-statusline';
  else if (settings === 'unsupported') reason = 'unsupported-statusline';
  else reason = 'not-installed';

  let plan: IntegrationPlan | undefined;
  let planBlocked: IntegrationDiagnosis['planBlocked'];
  if (installed) planBlocked = 'already-installed';
  else if (paths.cacheDir === undefined) planBlocked = 'no-cache-dir';
  else if (settings === 'invalid') planBlocked = 'invalid';
  else if (settings === 'unreadable') planBlocked = 'unreadable';
  else if (settings === 'unsupported') planBlocked = 'unsupported';
  else {
    const original = loaded.state === 'ok' ? (loaded.data['statusLine'] as { command?: string } | undefined) : undefined;
    const command = collectorCommand(paths.nodePath, paths.binPath, settings === 'other' ? original?.command : undefined);
    if (command === undefined) planBlocked = 'unavailable';
    else plan = { action: settings === 'other' ? 'chain' : 'add', command };
  }
  const status = cache.state === 'fresh' ? (cache as { status?: Awaited<ReturnType<typeof readClaudeCache>> }).status : undefined;
  return {
    settingsPath: paths.settingsPath,
    settings,
    cache: { state: cache.state, ...(cache.updatedAt === undefined ? {} : { updatedAt: cache.updatedAt }), ...(cache.ageSeconds === undefined ? {} : { ageSeconds: cache.ageSeconds }) },
    ...(status?.fiveHour === undefined ? {} : { fiveHour: status.fiveHour }),
    ...(status?.sevenDay === undefined ? {} : { sevenDay: status.sevenDay }),
    reason,
    installed,
    restorable,
    ...(plan === undefined ? {} : { plan }),
    ...(planBlocked === undefined ? {} : { planBlocked }),
  };
}

interface InstallRecord {
  readonly version: 1;
  readonly settingsPath: string;
  readonly original: unknown;
  readonly installed: unknown;
  readonly at: string;
}

async function readRecord(dir: string): Promise<InstallRecord | undefined> {
  try {
    const data = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8')) as Partial<InstallRecord>;
    return data.version === 1 && typeof data.settingsPath === 'string' ? (data as InstallRecord) : undefined;
  } catch {
    return undefined;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function writeAtomic(target: string, text: string, mode: number): Promise<void> {
  const real = await realpath(target).catch(() => target);
  const temp = join(dirname(real), `.acl-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx', mode });
    await rename(temp, real);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}

export type InstallResult =
  | { readonly ok: true; readonly action: 'add' | 'chain' | 'unchanged' }
  | { readonly ok: false; readonly reason: 'invalid' | 'unreadable' | 'unsupported' | 'unavailable' | 'no-cache-dir' | 'write-failed' };

/** Adds the collector to the user's own `statusLine`; an existing command is chained, never replaced. Reversible with `uninstallCollector`. */
export async function installCollector(paths: IntegrationPaths, now: Date): Promise<InstallResult> {
  if (paths.cacheDir === undefined) return { ok: false, reason: 'no-cache-dir' };
  const loaded = await loadSettings(paths.settingsPath);
  if (loaded.state === 'invalid' || loaded.state === 'unreadable') return { ok: false, reason: loaded.state };
  const data = loaded.state === 'ok' ? loaded.data : {};
  const kind = classify(data['statusLine']);
  if (kind === 'collector' || kind === 'chained') return { ok: true, action: 'unchanged' };
  if (kind === 'unsupported') return { ok: false, reason: 'unsupported' };
  const original = data['statusLine'] as Record<string, unknown> | undefined;
  const chained = kind === 'other' ? (original?.['command'] as string) : undefined;
  const command = collectorCommand(paths.nodePath, paths.binPath, chained);
  if (command === undefined) return { ok: false, reason: 'unavailable' };
  const statusLine = { ...(original ?? {}), type: 'command', command };
  const record: InstallRecord = { version: 1, settingsPath: paths.settingsPath, original: original ?? null, installed: statusLine, at: now.toISOString() };
  try {
    await ensureDir(paths.cacheDir);
    await writeFile(join(paths.cacheDir, INSTALL_RECORD), JSON.stringify(record), { mode: 0o600 });
    if (loaded.state === 'ok') await writeFile(join(paths.cacheDir, SETTINGS_BACKUP), loaded.text, { mode: 0o600 });
    await ensureDir(dirname(paths.settingsPath));
    const mode = loaded.state === 'ok' ? ((await stat(paths.settingsPath)).mode & 0o777) : 0o600;
    await writeAtomic(paths.settingsPath, `${JSON.stringify({ ...data, statusLine }, null, 2)}\n`, mode);
  } catch {
    await rm(join(paths.cacheDir, INSTALL_RECORD), { force: true });
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, action: chained === undefined ? 'add' : 'chain' };
}

export type UninstallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-record' | 'changed-since-install' | 'invalid' | 'unreadable' | 'write-failed' };

/** Puts the `statusLine` back exactly as it was before the install; refuses when the user changed it since. */
export async function uninstallCollector(paths: IntegrationPaths): Promise<UninstallResult> {
  if (paths.cacheDir === undefined) return { ok: false, reason: 'no-record' };
  const record = await readRecord(paths.cacheDir);
  if (record === undefined || record.settingsPath !== paths.settingsPath) return { ok: false, reason: 'no-record' };
  const loaded = await loadSettings(paths.settingsPath);
  if (loaded.state === 'invalid' || loaded.state === 'unreadable') return { ok: false, reason: loaded.state };
  if (loaded.state !== 'ok' || !isDeepStrictEqual(loaded.data['statusLine'], record.installed)) return { ok: false, reason: 'changed-since-install' };
  const next = { ...loaded.data };
  if (record.original === null) delete next['statusLine'];
  else next['statusLine'] = record.original;
  try {
    await writeAtomic(paths.settingsPath, `${JSON.stringify(next, null, 2)}\n`, (await stat(paths.settingsPath)).mode & 0o777);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  await rm(join(paths.cacheDir, INSTALL_RECORD), { force: true });
  await rm(join(paths.cacheDir, SETTINGS_BACKUP), { force: true });
  return { ok: true };
}
