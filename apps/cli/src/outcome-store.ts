import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_STORED_RECORDS, parseOutcomeLine, serializeOutcome, type OutcomeRecord, type OutcomeStore } from '@agent-control-lab/core';

export const OUTCOME_FILE = 'outcomes.jsonl';
const LOCK_DIR = 'outcomes.lock';
const MAX_FILE_BYTES = 1024 * 1024;
/** A lock older than this belongs to a process that died; the critical section takes milliseconds. */
const STALE_LOCK_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
/** Errors that mean "somebody else holds it right now" (Windows reports some of them as EPERM/EACCES/EBUSY). */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined);

/**
 * Cross-process mutual exclusion with a lock directory: `mkdir` either creates it or fails atomically on every
 * platform and file system we run on. A lock left by a crashed process is moved aside once it is stale. Waiting is
 * bounded; on timeout the caller gets an error and nothing is written (a run never hangs on its records).
 */
async function withLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
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
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) {
          const aside = `${lock}.stale-${randomBytes(6).toString('hex')}`;
          await rename(lock, aside).catch(() => undefined);
          await rm(aside, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // released between the failed mkdir and the stat: try again at once
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('outcome store is locked by another process');
      await delay(10 + Math.floor(Math.random() * 40));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
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
 * concurrent runs cannot lose each other's records and a crash never leaves a half-written file. Reads take no lock
 * (the file is always complete), are strict (malformed lines are skipped) and bounded; the newest records are kept.
 */
export function fileOutcomeStore(dir: string): OutcomeStore {
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
      await withLock(dir, async () => {
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
      withLock(dir, async () => {
        await rm(file, { force: true });
      }),
  };
}
