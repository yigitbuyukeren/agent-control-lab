import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STORED_RECORDS, type OutcomeRecord } from '@agent-control-lab/core';
import { fileOutcomeStore, OUTCOME_FILE } from './outcome-store.ts';
import { formatOutcomes } from './format.ts';
import { run } from './main.ts';

const rec = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  v: 1, day: '2026-10-20', step: 'implement', provider: 'codex', model: 'gpt-a', effort: 'low', task: 'general', size: 'small', outcome: 'pass', seconds: 12, ...over,
});
let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acl-outcomes-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('fileOutcomeStore', () => {
  it('appends, reloads, clears, and keeps the file owner-only where the platform allows it', async () => {
    const store = fileOutcomeStore(join(dir, 'sub'));
    expect(await store.load()).toEqual([]);
    await store.append([rec(), rec({ outcome: 'fail' })]);
    expect((await store.load()).map((r) => r.outcome)).toEqual(['pass', 'fail']);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'sub', OUTCOME_FILE)).mode & 0o077).toBe(0);
    await store.clear();
    expect(existsSync(join(dir, 'sub', OUTCOME_FILE))).toBe(false);
    expect(await store.load()).toEqual([]);
  });

  it('skips malformed or tampered lines and keeps only the newest records', async () => {
    writeFileSync(join(dir, OUTCOME_FILE), ['garbage', JSON.stringify({ ...rec(), task: 'my secret task' }), JSON.stringify(rec())].join('\n'));
    const store = fileOutcomeStore(dir);
    expect(await store.load()).toEqual([rec()]);
    await store.append(Array.from({ length: MAX_STORED_RECORDS + 5 }, (_, i) => rec({ seconds: i })));
    const all = await store.load();
    expect(all).toHaveLength(MAX_STORED_RECORDS);
    expect(all.at(-1)?.seconds).toBe(MAX_STORED_RECORDS + 4);
    expect(readFileSync(join(dir, OUTCOME_FILE), 'utf8')).not.toContain('secret');
  });
});

describe('concurrent writers', () => {
  it('loses no record when many stores append at once in one process', async () => {
    const stores = Array.from({ length: 8 }, () => fileOutcomeStore(dir));
    await Promise.all(stores.flatMap((store, w) => Array.from({ length: 10 }, (_, i) => store.append([rec({ seconds: w * 100 + i })]))));
    const seconds = (await fileOutcomeStore(dir).load()).map((r) => r.seconds).sort((a, b) => a - b);
    expect(seconds).toEqual(stores.flatMap((_, w) => Array.from({ length: 10 }, (__, i) => w * 100 + i)).sort((a, b) => a - b));
  });

  it('loses no record when separate processes append at once, and leaves no lock or temp file', async () => {
    const worker = fileURLToPath(new URL('./outcome-store.worker.ts', import.meta.url));
    const codes = await Promise.all(
      Array.from({ length: 5 }, (_, w) => new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [worker, dir, String(w), '15'], { stdio: 'ignore' });
        child.on('exit', resolve);
      })),
    );
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    const seconds = (await fileOutcomeStore(dir).load()).map((r) => r.seconds).sort((a, b) => a - b);
    expect(seconds).toEqual(Array.from({ length: 5 }, (_, w) => Array.from({ length: 15 }, (__, i) => w * 1000 + i)).flat().sort((a, b) => a - b));
    expect(readdirSync(dir)).toEqual([OUTCOME_FILE]);
  }, 60_000);

  it('takes over a lock left by a dead process, and gives up (without writing) on a fresh one', async () => {
    const lock = join(dir, 'outcomes.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await fileOutcomeStore(dir).append([rec()]);
    expect(await fileOutcomeStore(dir).load()).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('never leaves a partial file: a failed write keeps the old content', async () => {
    const store = fileOutcomeStore(dir);
    await store.append([rec()]);
    await expect(store.append([{ ...rec(), seconds: Number.NaN }])).resolves.toBeUndefined();
    expect((await store.load()).length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('outcomes command', () => {
  const call = async (argv: string[], withStore = true) => {
    let out = '';
    let error = '';
    const store = fileOutcomeStore(dir);
    const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, { ...(withStore ? { outcomes: store } : {}), now: () => new Date('2026-10-30T00:00:00Z') });
    return { code, out, error };
  };

  it('shows counts per comparable group, deletes on request and rejects other arguments', async () => {
    expect((await call(['outcomes'])).out).toContain('no local records');
    await fileOutcomeStore(dir).append([rec(), rec({ outcome: 'fail' }), rec({ outcome: 'unmeasured' })]);
    const shown = await call(['outcomes']);
    expect(shown.out).toContain('codex implement, general task, small');
    expect(shown.out).toContain('gpt-a / low: 1 pass, 1 fail');
    expect(shown.out).toContain('0 error, 0 timeout (0% of 3 runs), 1 unmeasured');
    expect(shown.out).toContain('(too few to count)');
    expect((await call(['outcomes', 'clear'])).out).toContain('deleted');
    expect(await fileOutcomeStore(dir).load()).toEqual([]);
    expect((await call(['outcomes', 'x'])).code).toBe(2);
    expect((await call(['outcomes'], false)).code).toBe(1);
  });

  it('formats an empty list', () => {
    expect(formatOutcomes([], new Date())).toContain('no local records');
  });
});
