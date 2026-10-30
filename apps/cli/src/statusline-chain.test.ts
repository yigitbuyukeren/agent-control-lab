import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectorCommand } from '@agent-control-lab/core';
import { run } from './main.ts';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'acl chain '));
  await writeFile(join(root, 'line.js'), "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write('LINE:'+JSON.parse(s).model+'\\n');process.stderr.write('E\\n');process.exit(Number(process.env.EXIT||0))})");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const INPUT = JSON.stringify({ model: 'm', rate_limits: { five_hour: { used_percentage: 31, resets_at: 1893456000 } } });
const io = () => {
  const o = { out: '', err: '' };
  return { o, io: { out: (t: string) => { o.out += t; }, error: (t: string) => { o.err += t; } } };
};
const chainArg = () => (collectorCommand('/n', '/a', `node "${join(root, 'line.js').replace(/\\/g, '/')}"`) ?? '').split(' --chain ')[1] ?? '';

describe('statusline-collect', () => {
  it('stays silent and writes the cache when not chained', async () => {
    const { o, io: i } = io();
    const code = await run(['statusline-collect'], i, { readStdin: () => Promise.resolve(INPUT), cacheDir: join(root, 'cache'), now: () => new Date('2026-10-31T12:00:00Z') });
    expect(code).toBe(0);
    expect(o).toEqual({ out: '', err: '' });
    expect((JSON.parse(await readFile(join(root, 'cache', 'claude-quota.json'), 'utf8')) as { fiveHour: { usedPercent: number } }).fiveHour.usedPercent).toBe(31);
  });
  it('chained: stores the quota, then shows exactly what the original command prints and returns its exit code', async () => {
    const { o, io: i } = io();
    const code = await run(['statusline-collect', '--chain', chainArg()], i, { readStdin: () => Promise.resolve(INPUT), cacheDir: join(root, 'cache'), now: () => new Date('2026-10-31T12:00:00Z') });
    expect(code).toBe(0);
    expect(o.out).toBe('LINE:m\n');
    expect(o.err).toBe('E\n');
    expect((JSON.parse(await readFile(join(root, 'cache', 'claude-quota.json'), 'utf8')) as { fiveHour: { usedPercent: number } }).fiveHour.usedPercent).toBe(31);
  });
  it('chained: the original still runs when the cache cannot be written', async () => {
    await writeFile(join(root, 'file'), 'x');
    const { o, io: i } = io();
    const code = await run(['statusline-collect', '--chain', chainArg()], i, { readStdin: () => Promise.resolve(INPUT), cacheDir: join(root, 'file', 'cache') });
    expect(o.out).toBe('LINE:m\n');
    expect(o.err).toContain('could not write the quota cache');
    expect(code).toBe(0);
  });
  it('rejects a malformed --chain without running anything', async () => {
    const { o, io: i } = io();
    expect(await run(['statusline-collect', '--chain', '***'], i, { readStdin: () => Promise.resolve(INPUT), cacheDir: join(root, 'cache') })).toBe(2);
    expect(o.out).toBe('');
  });
});
