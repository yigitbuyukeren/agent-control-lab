import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STORED_RECORDS, type OutcomeRecord } from '@agent-control-lab/core';
import { fileOutcomeStore, LOCK_DIR, OUTCOME_FILE, OutcomeStoreLockedError } from './outcome-store.ts';
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

  it('never takes over a lock by age: an old lock from a crashed run fails closed, keeps its data, and manual removal recovers', async () => {
    const store = fileOutcomeStore(dir, { waitMs: 150 });
    await store.append([rec({ seconds: 1 })]);
    const lock = join(dir, LOCK_DIR);
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: 2_000_000_000, token: 'dead' }));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    await expect(store.append([rec({ seconds: 2 })])).rejects.toBeInstanceOf(OutcomeStoreLockedError);
    await expect(store.clear()).rejects.toBeInstanceOf(OutcomeStoreLockedError);
    expect(existsSync(lock)).toBe(true);
    expect((await store.load()).map((r) => r.seconds)).toEqual([1]);
    rmSync(lock, { recursive: true });
    await store.append([rec({ seconds: 2 })]);
    expect((await store.load()).map((r) => r.seconds)).toEqual([1, 2]);
  });

  it('leaves half-written temp files from a crash harmless', async () => {
    writeFileSync(join(dir, `${OUTCOME_FILE}.999.abc.tmp`), '{"v":1,"day":"2026-10');
    const store = fileOutcomeStore(dir);
    await store.append([rec()]);
    expect(await store.load()).toEqual([rec()]);
  });

  it('a paused holder keeps its lock: waiters fail closed, nobody deletes it, and the holder loses nothing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const holder = fileOutcomeStore(dir, { whileLocked: () => { entered(); return gate; } });
    const held = holder.append([rec({ seconds: 11 })]);
    await inside;
    const lock = join(dir, LOCK_DIR);
    for (const other of [fileOutcomeStore(dir, { waitMs: 100 }), fileOutcomeStore(dir, { waitMs: 100 })]) {
      await expect(other.append([rec({ seconds: 22 })])).rejects.toBeInstanceOf(OutcomeStoreLockedError);
    }
    expect(existsSync(lock)).toBe(true);
    release();
    await held;
    expect(existsSync(lock)).toBe(false);
    await fileOutcomeStore(dir).append([rec({ seconds: 33 })]);
    expect((await fileOutcomeStore(dir).load()).map((r) => r.seconds)).toEqual([11, 33]);
  });

  it('a waiter gets in as soon as a slow but live holder finishes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = fileOutcomeStore(dir, { whileLocked: () => { entered(); return gate; } }).append([rec({ seconds: 1 })]);
    await inside;
    const waiting = fileOutcomeStore(dir, { waitMs: 5_000 }).append([rec({ seconds: 2 })]);
    setTimeout(release, 150);
    await Promise.all([held, waiting]);
    expect((await fileOutcomeStore(dir).load()).map((r) => r.seconds).sort()).toEqual([1, 2]);
  });

  it('release removes only its own lock: a lock somebody else created meanwhile survives', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = fileOutcomeStore(dir, { whileLocked: () => { entered(); return gate; } }).append([rec()]);
    await inside;
    const lock = join(dir, LOCK_DIR);
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, token: 'someone-else' }));
    release();
    await held;
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toContain('someone-else');
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

  it('reports a locked store on clear instead of crashing, and deletes nothing', async () => {
    await fileOutcomeStore(dir).append([rec()]);
    mkdirSync(join(dir, LOCK_DIR));
    let out = '';
    let error = '';
    const code = await run(['outcomes', 'clear'], { out: (t) => (out += t), error: (t) => (error += t) }, { outcomes: fileOutcomeStore(dir, { waitMs: 50 }) });
    expect(code).toBe(1);
    expect(error).toContain('nothing was deleted');
    expect(out).toBe('');
    expect(await fileOutcomeStore(dir).load()).toHaveLength(1);
  });

  it('formats an empty list', () => {
    expect(formatOutcomes([], new Date())).toContain('no local records');
  });
});
