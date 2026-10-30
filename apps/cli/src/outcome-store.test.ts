import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    expect(shown.out).toContain('gpt-a / low: 1 pass, 1 fail, 0 error/timeout, 1 unmeasured');
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
