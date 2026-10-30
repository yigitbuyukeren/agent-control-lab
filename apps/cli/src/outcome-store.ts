import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_STORED_RECORDS, parseOutcomeLine, serializeOutcome, type OutcomeRecord, type OutcomeStore } from '@agent-control-lab/core';

export const OUTCOME_FILE = 'outcomes.jsonl';
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Records in one JSON-lines file inside the per-user cache directory (owner-only where the platform supports it).
 * Reads are strict (malformed lines are skipped) and bounded; a write keeps only the newest records.
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
      const kept = [...(await load()), ...records].slice(-MAX_STORED_RECORDS);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${kept.map(serializeOutcome).join('\n')}\n`, { mode: 0o600 });
      await rename(tmp, file);
      await chmod(file, 0o600).catch(() => undefined);
    },
    clear: async () => {
      await rm(file, { force: true });
    },
  };
}
