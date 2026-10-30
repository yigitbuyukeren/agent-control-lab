import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_STORED_RECORDS, parseOutcomeLine, serializeOutcome, type OutcomeRecord, type OutcomeStore } from '@agent-control-lab/core';

export const OUTCOME_FILE = 'outcomes.jsonl';
export const LOCK_DIR = 'outcomes.lock';
const OWNER_FILE = 'owner';
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS = 10_000;
/** Errors that mean "somebody else holds it right now" (Windows reports some of them as EPERM/EACCES/EBUSY). */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);

/**
 * The store could not be locked within the wait. Nothing was written. The holder may be a live run that is
 * slow or paused, or a run that crashed and left the lock behind: telling those apart needs a liveness proof
 * that does not exist across platforms (a lock's age proves nothing, a process id can be reused), so the lock is
 * never taken over automatically. See docs/ORCHESTRATE.md for the manual recovery.
 */
export class OutcomeStoreLockedError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`the outcome store is locked (${lockPath})`);
    this.name = 'OutcomeStoreLockedError';
    this.lockPath = lockPath;
  }
}

export interface OutcomeStoreOptions {
  /** How long a change waits for the lock before failing closed. */
  readonly waitMs?: number;
  /** Test seam: runs while the lock is held, before the file is changed. */
  readonly whileLocked?: () => Promise<void>;
}

/**
 * Cross-process mutual exclusion with a lock directory: `mkdir` either creates it or fails atomically on every
 * platform and file system we run on. The holder writes a random token into it and, on release, removes the lock
 * only if that token is still its own. A waiter that times out fails closed; it never removes or replaces a lock it
 * did not create, so two live processes cannot both be inside the critical section.
 */
async function withLock<T>(dir: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, LOCK_DIR);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !CONTENDED.has(code)) throw error;
      if (Date.now() - started > waitMs) throw new OutcomeStoreLockedError(lock);
      await delay(10 + Math.floor(Math.random() * 40));
    }
  }
  const token = randomBytes(12).toString('hex');
  try {
    await writeFile(join(lock, OWNER_FILE), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  } catch (error) {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  try {
    return await work();
  } finally {
    const owner = await readFile(join(lock, OWNER_FILE), 'utf8').catch(() => '');
    if (owner.includes(`"token":"${token}"`)) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Windows can refuse a rename while another process has the target open for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}

/**
 * Records in one JSON-lines file inside the per-user cache directory (owner-only where the platform supports it).
 * Every change runs under a cross-process lock and replaces the file atomically (unique temp file, then rename), so
 * concurrent runs cannot lose each other's records and a crash never leaves a half-written file. If the lock cannot
 * be had in time the change is not made (`OutcomeStoreLockedError`). Reads take no lock
 * (the file is always complete), are strict (malformed lines are skipped) and bounded; the newest records are kept.
 */
export function fileOutcomeStore(dir: string, options: OutcomeStoreOptions = {}): OutcomeStore {
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const file = join(dir, OUTCOME_FILE);
  const load = async (): Promise<OutcomeRecord[]> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    if (text.length > MAX_FILE_BYTES) text = text.slice(-MAX_FILE_BYTES);
    return text.split('\n').flatMap((line) => {
      const record = line === '' ? undefined : parseOutcomeLine(line);
      return record === undefined ? [] : [record];
    });
  };
  return {
    load,
    append: async (records) => {
      if (records.length === 0) return;
      await withLock(dir, waitMs, async () => {
        await options.whileLocked?.();
        const kept = [...(await load()), ...records].slice(-MAX_STORED_RECORDS);
        const tmp = join(dir, `${OUTCOME_FILE}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
        try {
          await writeFile(tmp, `${kept.map(serializeOutcome).join('\n')}\n`, { mode: 0o600 });
          await renameWithRetry(tmp, file);
        } finally {
          await rm(tmp, { force: true }).catch(() => undefined);
        }
        await chmod(file, 0o600).catch(() => undefined);
      });
    },
    clear: () =>
      withLock(dir, waitMs, async () => {
        await rm(file, { force: true });
      }),
  };
}
