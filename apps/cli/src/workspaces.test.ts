import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './main.ts';

let base = '';
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'acl ws cli '));
  await mkdir(join(base, 'billing', '.git'), { recursive: true });
  await mkdir(join(base, 'web', '.git'), { recursive: true });
  await mkdir(join(base, 'a', 'shared'), { recursive: true });
  await mkdir(join(base, 'b', 'shared'), { recursive: true });
  await writeFile(join(base, 'a', 'shared', 'package.json'), '{"name":"shared"}');
  await writeFile(join(base, 'b', 'shared', 'package.json'), '{"name":"shared"}');
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

async function cli(argv: string[]) {
  let out = '';
  let error = '';
  const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) });
  return { code, out, error };
}

describe('workspaces command', () => {
  it('lists candidates read-only', async () => {
    const r = await cli(['workspaces', '--root', base]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('billing  [git-repo');
    expect(r.out).toContain('web  [git-repo');
    expect(r.out).not.toContain('suggestion');
  });

  it('suggests from the task with reasons but does not apply it', async () => {
    const r = await cli(['workspaces', '--root', base, '--task', 'fix the billing invoices']);
    expect(r.out).toContain('suggestion (not applied');
    expect(r.out).toContain('task mentions the name "billing"');
    expect(r.out).not.toContain('selected:');
  });

  it('does not decide an ambiguous task', async () => {
    const r = await cli(['workspaces', '--root', base, '--task', 'update shared helpers']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ambiguous, nothing was chosen');
    expect(r.out).not.toContain('selected:');
  });

  it('selects manually and refuses an ambiguous or unknown choice', async () => {
    const ok = await cli(['workspaces', '--root', base, '--select', 'web']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('(chosen manually)');
    const amb = await cli(['workspaces', '--root', base, '--select', 'shared']);
    expect(amb.code).toBe(1);
    expect(amb.error).toContain('choose by relative path');
    expect((await cli(['workspaces', '--root', base, '--select', 'nope'])).code).toBe(1);
  });

  it('prints JSON with the suggestion state', async () => {
    const r = await cli(['workspaces', '--root', base, '--task', 'update shared helpers', '--json']);
    const parsed = JSON.parse(r.out) as { suggestion: { state: string }; candidates: unknown[] };
    expect(parsed.suggestion.state).toBe('ambiguous');
    expect(parsed.candidates.length).toBeGreaterThan(2);
  });

  it('rejects bad usage and unreadable roots', async () => {
    expect((await cli(['workspaces'])).code).toBe(2);
    expect((await cli(['workspaces', '--root'])).code).toBe(2);
    expect((await cli(['workspaces', '--root', base, '--task', 'x', '--select', 'web'])).code).toBe(2);
    expect((await cli(['workspaces', '--root', base, '--bogus'])).code).toBe(2);
    const missing = await cli(['workspaces', '--root', join(base, 'missing')]);
    expect(missing.code).toBe(1);
  });
});
