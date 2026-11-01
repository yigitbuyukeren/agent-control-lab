import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore, type WorkflowResult } from '@agent-control-lab/core';
import { gitSync, makeWorktreeFixture } from '../../../packages/core/src/git-fixture.ts';
import { run } from './main.ts';
import { beginTask, recordTask } from './task-recorder.ts';
import { runTasksCommand } from './tasks-cmd.ts';

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), error: (t: string) => err.push(t) } };
};
const result = (status: WorkflowResult['status']): WorkflowResult => ({
  workflow: 'plan-implement-review',
  status,
  partial: status !== 'completed',
  steps: [
    { id: 'plan', title: 'Plan', provider: 'claude', status: 'completed', output: 'SECRET PLAN TEXT' },
    { id: 'implement', title: 'Implement', provider: 'codex', status: status === 'completed' ? 'completed' : 'failed' },
    { id: 'review', title: 'Review', provider: 'claude', status: status === 'completed' ? 'completed' : 'skipped', output: 'SECRET REVIEW' },
  ],
});

describe('task history', () => {
  it('records a run without prompt or output, then lists, shows, checks and clears it', async () => {
    const fx = makeWorktreeFixture();
    const store = new TaskStore(mkdtempSync(join(tmpdir(), 'acl hist ')));
    writeFileSync(join(fx.wt, 'new.txt'), 'x');
    const line = await recordTask(store, true, { workflow: 'plan-implement-review', cwd: fx.wt, result: result('completed'), now: new Date() });
    expect(line).toContain('recorded t-');
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const text = JSON.stringify(listed[0]);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('new.txt');
    const id = listed[0]?.ok ? listed[0].packet.taskId : '';

    const a = io();
    expect(await runTasksCommand([], a.io, store)).toBe(0);
    expect(a.out.join('')).toContain(id);

    // A completed task has nothing to continue.
    const b = io();
    const code = await runTasksCommand(['resume-check', id], b.io, store);
    expect(code).toBe(1);
    expect(b.out.join('')).toContain('already-finished');
  });

  it('lets an unchanged failed task continue', async () => {
    const fx = makeWorktreeFixture();
    const store = new TaskStore(mkdtempSync(join(tmpdir(), 'acl hist ')));
    await recordTask(store, true, { workflow: 'plan-review', cwd: fx.wt, result: result('failed'), now: new Date() });
    const task = (await store.list())[0];
    const e = io();
    expect(await runTasksCommand(['resume-check', task?.ok ? task.packet.taskId : ''], e.io, store)).toBe(0);
    expect(e.out.join('')).toContain('safe to continue');
  });

  it('detects a moved HEAD on resume-check', async () => {
    const fx = makeWorktreeFixture();
    const store = new TaskStore(mkdtempSync(join(tmpdir(), 'acl hist ')));
    await recordTask(store, true, { workflow: 'plan-review', cwd: fx.wt, result: result('failed'), now: new Date() });
    const task = (await store.list())[0];
    const id = task?.ok ? task.packet.taskId : '';
    writeFileSync(join(fx.wt, 'b.txt'), 'b');
    gitSync(fx.wt, 'add', 'b.txt');
    gitSync(fx.wt, 'commit', '-q', '-m', 'move');
    const c = io();
    expect(await runTasksCommand(['resume-check', id], c.io, store)).toBe(1);
    expect(c.out.join('')).toContain('head-changed');
  });

  it('honours --no-record, bad ids and missing stores', async () => {
    const store = new TaskStore(mkdtempSync(join(tmpdir(), 'acl hist ')));
    expect(await recordTask(store, false, { workflow: 'x', cwd: '.', result: result('completed'), now: new Date() })).toContain('not recorded');
    expect(await store.list()).toEqual([]);
    const d = io();
    expect(await runTasksCommand(['show', '../etc'], d.io, store)).toBe(2);
    expect(await runTasksCommand([], d.io, undefined)).toBe(1);
    expect((await run(['tasks', 'bogus'], d.io, { tasks: store }))).toBe(2);
  });
});

describe('worktree command', () => {
  it('shows a plan by default, creates only with --confirm, lists and removes', async () => {
    const { runWorktreeCommand } = await import('./worktree-cmd.ts');
    const fx = makeWorktreeFixture();
    const data = mkdtempSync(join(tmpdir(), 'acl wtc '));
    const a = io();
    expect(await runWorktreeCommand(['create', '--repo', fx.main], a.io, data)).toBe(0);
    expect(a.out.join('')).toContain('nothing was created');
    const b = io();
    expect(await runWorktreeCommand(['create', '--repo', fx.main, '--confirm'], b.io, data)).toBe(0);
    const c = io();
    await runWorktreeCommand(['list'], c.io, data);
    const id = /(t-[0-9a-f]{12})/.exec(c.out.join(''))?.[1] ?? '';
    expect(id).not.toBe('');
    const d = io();
    expect(await runWorktreeCommand(['remove', id], d.io, data)).toBe(0);
    expect(d.out.join('')).toContain('add --confirm');
    expect(await runWorktreeCommand(['remove', id, '--confirm'], d.io, data)).toBe(0);
    expect(await runWorktreeCommand(['bogus'], d.io, data)).toBe(2);
    expect(await runWorktreeCommand(['list'], d.io, undefined)).toBe(1);
  });
});

describe('crash visibility', () => {
  it('leaves a running record at start that shows as interrupted when the process is gone, and one record after a normal finish', async () => {
    const fx = makeWorktreeFixture();
    const dir = mkdtempSync(join(tmpdir(), 'acl crash '));
    const begun = await beginTask(new TaskStore(dir), true, { workflow: 'plan-implement-review', cwd: fx.wt, now: new Date(), pid: 999_999 });
    expect(begun).toBeDefined();
    const afterCrash = new TaskStore(dir, { pidAlive: () => false });
    const t = (await afterCrash.list())[0];
    expect(t?.ok && t.packet.status).toBe('interrupted');
    const c = io();
    expect(await runTasksCommand(['list'], c.io, afterCrash)).toBe(0);
    expect(c.out.join('')).toContain('its process is gone');
    // A normal finish updates the same record instead of adding another one.
    const store = new TaskStore(dir);
    await recordTask(store, true, { workflow: 'plan-implement-review', cwd: fx.wt, result: result('completed'), now: new Date(), begun });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.ok && all[0].packet.status).toBe('completed');
    expect(all[0]?.ok && all[0].packet.taskId).toBe(begun?.taskId);
    expect(all[0]?.ok && all[0].packet.owner).toBeUndefined();
  });

  it('writes nothing when recording is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl crash '));
    expect(await beginTask(new TaskStore(dir), false, { workflow: 'x', cwd: '.', now: new Date() })).toBeUndefined();
    expect(await new TaskStore(dir).list()).toEqual([]);
  });
});
