import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { gitSync, makeWorktreeFixture } from './git-fixture.ts';
import { createWorkspaceInspector, prepareWorkspace } from './workspace-guard.ts';
import type { StepOutcome } from './orchestration.ts';

const fx = makeWorktreeFixture();
afterAll(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

// Every test starts from a clean worktree on `feature`, one commit ahead state reset.
beforeEach(() => {
  gitSync(fx.wt, 'checkout', '-q', 'feature');
  gitSync(fx.wt, 'reset', '-q', '--hard', 'main');
  gitSync(fx.wt, 'clean', '-q', '-fd');
});

describe('prepareWorkspace (real git)', () => {
  it('accepts a clean linked worktree', async () => {
    const result = await prepareWorkspace(fx.wt);
    expect(result).toMatchObject({ ok: true, before: { branch: 'feature', linked: true } });
  });

  it('rejects the main worktree, a dirty worktree and a protected branch', async () => {
    expect(await prepareWorkspace(fx.main)).toMatchObject({ ok: false, reason: 'workspace-rejected', problems: ['not-a-linked-worktree', 'protected-branch'] });
    writeFileSync(join(fx.wt, 'dirty.txt'), 'x');
    expect(await prepareWorkspace(fx.wt)).toMatchObject({ ok: false, problems: ['workspace-dirty'] });
  });

  it('fails closed outside a repository', async () => {
    expect(await prepareWorkspace(fx.root)).toEqual({ ok: false, reason: 'git-state-unreadable' });
  });
});

describe('createWorkspaceInspector (real git, no model)', () => {
  async function inspect(change: () => void): Promise<StepOutcome> {
    const prep = await prepareWorkspace(fx.wt);
    if (!prep.ok) throw new Error('fixture not ready');
    change();
    return createWorkspaceInspector({ cwd: fx.wt, before: prep.before })();
  }

  it('reports an in-limits change as completed with the diff', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
      mkdirSync(join(fx.wt, 'src'));
      writeFileSync(join(fx.wt, 'src', 'b.ts'), 'export const b = 1;\n');
    });
    expect(outcome.kind).toBe('completed');
    const output = outcome.kind === 'completed' ? outcome.output : '';
    expect(output).toContain('branch: feature');
    expect(output).toContain('+1 -1');
    expect(output).toContain('new  src/b.ts');
    expect(output).toContain('policy: ok');
    expect(output).toContain('+TWO');
  });

  it('rejects no change, keeping the report', async () => {
    const outcome = await inspect(() => undefined);
    expect(outcome).toMatchObject({ kind: 'rejected', error: 'workspace policy: no-changes' });
  });

  it('rejects a commit made by the step, and the report still shows the state', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'a.txt'), 'changed\n');
      gitSync(fx.wt, 'commit', '-q', '-am', 'sneaky');
      writeFileSync(join(fx.wt, 'c.txt'), 'x\n');
    });
    expect(outcome).toMatchObject({ kind: 'rejected' });
    expect(outcome.kind === 'rejected' && outcome.error).toContain('head-moved');
    expect(outcome.kind === 'rejected' && outcome.output).toContain('policy: head-moved');
  });

  it('rejects a created, moved or deleted branch other than its own', async () => {
    const created = await inspect(() => {
      writeFileSync(join(fx.wt, 'a.txt'), 'again\n');
      gitSync(fx.wt, 'branch', 'extra');
    });
    expect(created.kind === 'rejected' && created.error).toBe('workspace policy: other-branch-changed');
    // `extra` now exists in the "before" state of the next run; deleting it must be caught too.
    gitSync(fx.wt, 'reset', '-q', '--hard', 'main');
    const deleted = await inspect(() => {
      writeFileSync(join(fx.wt, 'a.txt'), 'once more\n');
      gitSync(fx.wt, 'branch', '-D', 'extra');
    });
    expect(deleted.kind === 'rejected' && deleted.error).toBe('workspace policy: other-branch-changed');
  });

  it('rejects protected paths and oversized changes', async () => {
    const protectedPath = await inspect(() => {
      mkdirSync(join(fx.wt, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(fx.wt, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    });
    expect(protectedPath.kind === 'rejected' && protectedPath.error).toBe('workspace policy: protected-path');
    gitSync(fx.wt, 'clean', '-q', '-fd');
    const prep = await prepareWorkspace(fx.wt);
    if (!prep.ok) throw new Error('fixture not ready');
    writeFileSync(join(fx.wt, 'big.txt'), 'x'.repeat(50));
    const tight = await createWorkspaceInspector({ cwd: fx.wt, before: prep.before, limits: { maxFiles: 5, maxChangedLines: 5, maxNewFileBytes: 10, maxNewBytes: 10 } })();
    expect(tight.kind === 'rejected' && tight.error).toContain('new-file-too-large');
  });

  it('reports an unreadable workspace instead of guessing', async () => {
    const prep = await prepareWorkspace(fx.wt);
    if (!prep.ok) throw new Error('fixture not ready');
    const outcome = await createWorkspaceInspector({ cwd: fx.root, before: prep.before })();
    expect(outcome.kind === 'rejected' && outcome.error).toContain('could not be read');
  });
});
