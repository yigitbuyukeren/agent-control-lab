import { existsSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitSync, makeWorktreeFixture } from './git-fixture.ts';
import { newTaskId } from './task-store.ts';
import { createWorktree, listManagedWorktrees, planWorktree, removeManagedWorktree } from './worktree-manager.ts';

const data = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'acl wtdata ')));

describe('worktree manager', () => {
  it('plans without touching anything, then creates a linked worktree on its own branch', async () => {
    const fx = makeWorktreeFixture();
    const dir = data();
    const id = newTaskId();
    const plan = await planWorktree(fx.main, id, dir);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(existsSync(plan.path)).toBe(false);
    expect(plan.branch).toBe(`acl/${id}`);
    expect(gitSync(fx.main, 'branch', '--list', plan.branch)).toBe('');
    const made = await createWorktree(plan, dir, new Date());
    expect(made.ok).toBe(true);
    expect(gitSync(plan.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(plan.branch);
    expect(gitSync(plan.path, 'rev-parse', 'HEAD')).toBe(plan.baseHead);
    expect(await listManagedWorktrees(dir)).toHaveLength(1);
    // main checkout is untouched
    expect(gitSync(fx.main, 'status', '--porcelain')).toBe('');
    expect(gitSync(fx.main, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('plans from a linked worktree against the main repository, refuses non-repos and bad ids', async () => {
    const fx = makeWorktreeFixture();
    const dir = data();
    const plan = await planWorktree(fx.wt, newTaskId(), dir);
    expect(plan.ok && plan.repoRoot).toBe(fx.main);
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl plain ')));
    expect(await planWorktree(plain, newTaskId(), dir)).toEqual({ ok: false, problem: 'not-a-repo' });
    expect(await planWorktree(fx.main, '../x', dir)).toEqual({ ok: false, problem: 'bad-task-id' });
  });

  it('refuses a data directory inside the repository and an existing branch or target', async () => {
    const fx = makeWorktreeFixture();
    const id = newTaskId();
    expect(await planWorktree(fx.main, id, join(fx.main, 'inside'))).toEqual({ ok: false, problem: 'target-inside-repo' });
    gitSync(fx.main, 'branch', `acl/${id}`);
    expect(await planWorktree(fx.main, id, data())).toEqual({ ok: false, problem: 'branch-exists' });
  });

  it('removes a clean managed worktree and its untouched branch only', async () => {
    const fx = makeWorktreeFixture();
    const dir = data();
    const plan = await planWorktree(fx.main, newTaskId(), dir);
    if (!plan.ok) throw new Error('plan');
    await createWorktree(plan, dir, new Date());
    const out = await removeManagedWorktree(dir, plan.taskId);
    expect(out).toEqual({ ok: true, branchKept: false });
    expect(existsSync(plan.path)).toBe(false);
    expect(gitSync(fx.main, 'branch', '--list', plan.branch)).toBe('');
    expect(await listManagedWorktrees(dir)).toEqual([]);
  });

  it('refuses dirty worktrees, keeps a branch that holds commits, and never touches unmanaged worktrees', async () => {
    const fx = makeWorktreeFixture();
    const dir = data();
    const plan = await planWorktree(fx.main, newTaskId(), dir);
    if (!plan.ok) throw new Error('plan');
    await createWorktree(plan, dir, new Date());
    writeFileSync(join(plan.path, 'u.txt'), 'untracked');
    expect(await removeManagedWorktree(dir, plan.taskId)).toEqual({ ok: false, problem: 'dirty' });
    expect(existsSync(plan.path)).toBe(true);
    gitSync(plan.path, 'add', 'u.txt');
    gitSync(plan.path, 'commit', '-q', '-m', 'work');
    expect(await removeManagedWorktree(dir, plan.taskId)).toEqual({ ok: true, branchKept: true });
    expect(gitSync(fx.main, 'branch', '--list', plan.branch)).toContain(plan.branch);
    // the user's own linked worktree is not in the registry and cannot be removed through the tool
    expect(await removeManagedWorktree(dir, newTaskId())).toEqual({ ok: false, problem: 'not-managed' });
    expect(existsSync(fx.wt)).toBe(true);
  });

  it('refuses removal when the recorded path was swapped for a symlink elsewhere', async () => {
    const fx = makeWorktreeFixture();
    const dir = data();
    const plan = await planWorktree(fx.main, newTaskId(), dir);
    if (!plan.ok) throw new Error('plan');
    await createWorktree(plan, dir, new Date());
    gitSync(fx.main, 'worktree', 'remove', plan.path);
    symlinkSync(fx.wt, plan.path);
    const out = await removeManagedWorktree(dir, plan.taskId);
    expect(out.ok).toBe(false);
    expect(existsSync(fx.wt)).toBe(true);
  });
});
