import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '@agent-control-lab/core';
import { gitSync, makeWorktreeFixture } from '../../../packages/core/src/git-fixture.ts';
import { createGuiServer, listenGui } from './gui.ts';
import { run } from './main.ts';

const TOKEN = 'prep-token';
const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => { r(); }); })));
});

async function boot() {
  const cacheDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl prep ')));
  const server = createGuiServer({
    token: TOKEN,
    run: (argv, io) => run(argv, io, { cacheDir, tasks: new TaskStore(cacheDir), sandbox: { mode: 'unavailable', reason: 'test' } }),
  });
  open.push(server);
  const base = `http://127.0.0.1:${String(await listenGui(server, 0))}`;
  const call = (path: string, body?: unknown, token = TOKEN) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, cacheDir };
}

describe('GUI preparation endpoints', () => {
  it('need the token and a host check like every other endpoint', async () => {
    const { call } = await boot();
    for (const [path, body] of [['/api/doctor', undefined], ['/api/tasks', undefined], ['/api/instructions', { cwd: '/' }], ['/api/worktree', { repo: '/' }]] as const) {
      expect((await call(path, body, 'wrong')).status).toBe(403);
    }
  });

  it('shows the first-run check and an empty history without calling a model', async () => {
    const { call } = await boot();
    const doctor = (await (await call('/api/doctor')).json()) as { items: { id: string }[] };
    expect(doctor.items.map((c) => c.id)).toEqual(expect.arrayContaining(['node', 'git', 'sandbox', 'data']));
    expect(((await (await call('/api/tasks')).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('lists instruction files read-only and rejects relative or hostile paths', async () => {
    const { call } = await boot();
    const proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl gp ')));
    mkdirSync(join(proj, '.git'));
    writeFileSync(join(proj, 'AGENTS.md'), 'rules');
    const ok = (await (await call('/api/instructions', { cwd: proj })).json()) as { codex: { entries: { path: string }[] } };
    expect(ok.codex.entries.some((e) => e.path === join(proj, 'AGENTS.md'))).toBe(true);
    expect((await call('/api/instructions', { cwd: 'relative' })).status).toBe(400);
    expect((await call('/api/instructions', { cwd: `${proj}\0x` })).status).toBe(400);
    expect((await call('/api/instructions', {})).status).toBe(400);
  });

  it('shows a worktree plan first and creates it only with confirm, leaving the repository untouched', async () => {
    const { call } = await boot();
    const fx = makeWorktreeFixture();
    const plan = (await (await call('/api/worktree', { repo: fx.main })).json()) as { exitCode: number; output: string; created: boolean };
    expect(plan.exitCode).toBe(0);
    expect(plan.created).toBe(false);
    expect(plan.output).toContain('nothing was created');
    const made = (await (await call('/api/worktree', { repo: fx.main, confirm: true })).json()) as { created: boolean; workspace?: string };
    expect(made.created).toBe(true);
    expect(made.workspace).toBeDefined();
    expect(gitSync(made.workspace ?? '', 'rev-parse', '--abbrev-ref', 'HEAD')).toMatch(/^acl\/t-/);
    expect(gitSync(fx.main, 'status', '--porcelain')).toBe('');
    expect(gitSync(fx.main, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect((await call('/api/worktree', { repo: 'relative', confirm: true })).status).toBe(400);
  });
});
