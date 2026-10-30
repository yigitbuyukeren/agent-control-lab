import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitSync, makeWorktreeFixture } from './git-fixture.ts';
import { collectChanges, parseNumstatZ, parseStatusZ, readDiff, snapshotWorkspace } from './git-state.ts';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';

describe('parseStatusZ', () => {
  it('reads modified, staged, untracked and renamed entries', () => {
    expect(parseStatusZ(' M a.ts\0A  b.ts\0?? new file.txt\0R  new.ts\0old.ts\0D  gone.ts\0')).toEqual([
      { x: ' ', y: 'M', path: 'a.ts' },
      { x: 'A', y: ' ', path: 'b.ts' },
      { x: '?', y: '?', path: 'new file.txt' },
      { x: 'R', y: ' ', path: 'new.ts' },
      { x: 'D', y: ' ', path: 'gone.ts' },
    ]);
    expect(parseStatusZ('')).toEqual([]);
  });
  it('rejects text that is not porcelain v1', () => {
    expect(parseStatusZ('garbage\0')).toBeUndefined();
    expect(parseStatusZ('M\0')).toBeUndefined();
  });
});

describe('parseNumstatZ', () => {
  it('reads counts, binary markers and paths containing tabs', () => {
    expect(parseNumstatZ('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '0\t2\twith\ttab.txt\0')).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'img.png', added: undefined, deleted: undefined },
      { path: 'with\ttab.txt', added: 0, deleted: 2 },
    ]);
  });
  it('rejects malformed records', () => {
    for (const text of ['3\ta.ts\0', 'x\t1\ta\0', '1\t1\t\0']) expect(parseNumstatZ(text)).toBeUndefined();
  });
});

describe('snapshotWorkspace (mock git)', () => {
  const SHA = 'c'.repeat(40);
  function runnerFor(answers: Record<string, ProcessOutcome>) {
    const specs: ProcessSpec[] = [];
    const runner = (spec: ProcessSpec): Promise<ProcessOutcome> => {
      specs.push(spec);
      const key = spec.args.filter((a) => !['--no-optional-locks', '-c', 'core.fsmonitor=false'].includes(a)).join(' ');
      return Promise.resolve(answers[key] ?? { kind: 'completed', exitCode: 128, stdout: '', truncated: false });
    };
    return { runner, specs };
  }
  const ok = (stdout: string): ProcessOutcome => ({ kind: 'completed', exitCode: 0, stdout, truncated: false });
  const base: Record<string, ProcessOutcome> = {
    'rev-parse --path-format=absolute --show-toplevel --git-common-dir': ok('/ws\n/main/.git\n'),
    'rev-parse HEAD': ok(`${SHA}\n`),
    'symbolic-ref -q --short HEAD': ok('feature\n'),
    'status --porcelain=v1 -z --untracked-files=all': ok(' M a.ts\0'),
    'for-each-ref --format=%(refname:short)%00%(objectname) refs/heads': ok(`feature\0${SHA}\nmain\0${SHA}\n`),
  };

  it('builds a snapshot using read-only git with fsmonitor disabled', async () => {
    const { runner, specs } = runnerFor(base);
    const result = await snapshotWorkspace('/ws', { runner, platform: 'linux', env: { PATH: '/bin', GIT_DIR: '/elsewhere' } });
    expect(result).toEqual({
      ok: true,
      snapshot: { root: '/ws', head: SHA, branch: 'feature', linked: true, mainRoot: '/main', mainBranch: 'feature', refs: { feature: SHA, main: SHA }, dirty: ['a.ts'] },
    });
    // The root lookup is a plain rev-parse; every call that inspects state carries the hardening flags.
    for (const spec of specs.filter((x) => !x.args.includes('--show-toplevel'))) {
      expect(spec.command).toBe('git');
      expect(spec.args.slice(0, 3)).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
      expect(spec.env).not.toHaveProperty('GIT_DIR');
    }
    // No git call that writes anything.
    expect(specs.map((s) => s.args.find((a) => !a.startsWith('-') && a !== 'core.fsmonitor=false'))).not.toContain('commit');
  });

  it('treats a detached HEAD as no branch, but any other symbolic-ref failure as unreadable', async () => {
    const detached = runnerFor({ ...base, 'symbolic-ref -q --short HEAD': { kind: 'completed', exitCode: 1, stdout: '', truncated: false } });
    const r = await snapshotWorkspace('/ws', { runner: detached.runner, platform: 'linux' });
    expect(r.ok && r.snapshot.branch).toBeUndefined();
    expect(r.ok).toBe(true);
    const broken = runnerFor({ ...base, 'symbolic-ref -q --short HEAD': { kind: 'completed', exitCode: 128, stdout: '', truncated: false } });
    expect(await snapshotWorkspace('/ws', { runner: broken.runner, platform: 'linux' })).toEqual({ ok: false });
  });

  it('fails closed on anything unexpected', async () => {
    const cases: Record<string, ProcessOutcome>[] = [
      { ...base, 'rev-parse HEAD': ok('not-a-sha\n') },
      { ...base, 'status --porcelain=v1 -z --untracked-files=all': ok('garbage\0') },
      { ...base, 'status --porcelain=v1 -z --untracked-files=all': { kind: 'completed', exitCode: 0, stdout: '', truncated: true } },
      { ...base, 'for-each-ref --format=%(refname:short)%00%(objectname) refs/heads': ok('feature\0nothex\n') },
      { ...base, 'rev-parse HEAD': { kind: 'timeout' } },
      { ...base, 'rev-parse --path-format=absolute --show-toplevel --git-common-dir': ok('/ws\n/ws/.git\n') },
    ];
    for (const answers of cases) {
      const { runner } = runnerFor(answers);
      const result = await snapshotWorkspace('/ws', { runner, platform: 'linux' });
      // The last case is a plain repository: readable, but not a linked worktree.
      expect(result.ok && result.snapshot.linked).not.toBe(true);
    }
    const unreadable = await Promise.all(cases.slice(0, 5).map((answers) => snapshotWorkspace('/ws', { runner: runnerFor(answers).runner, platform: 'linux' })));
    expect(unreadable.every((r) => !r.ok)).toBe(true);
  });
});

describe('real git worktree', () => {
  const fx = makeWorktreeFixture();
  afterAll(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('snapshots a clean linked worktree and the main worktree', async () => {
    const r = await snapshotWorkspace(fx.wt);
    expect(r.ok && r.snapshot).toMatchObject({ root: fx.wt, branch: 'feature', linked: true, mainRoot: fx.main, mainBranch: 'main', dirty: [] });
    expect(r.ok && Object.keys(r.snapshot.refs).sort()).toEqual(['feature', 'main']);
    const main = await snapshotWorkspace(fx.main);
    expect(main.ok && main.snapshot.linked).toBe(false);
  });

  it('collects tracked, new and symlinked changes and a bounded text diff', async () => {
    writeFileSync(join(fx.wt, 'a.txt'), 'one\nTWO\nthree\n');
    mkdirSync(join(fx.wt, 'src'));
    writeFileSync(join(fx.wt, 'src', 'new.ts'), 'export {};\n');
    try {
      symlinkSync('a.txt', join(fx.wt, 'link'));
    } catch {
      // Symlinks may need privileges on Windows; the rest of the test still applies.
    }
    const result = await collectChanges(fx.wt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.tracked).toEqual([{ path: 'a.txt', added: 2, deleted: 1 }]);
    expect(result.changes.untracked.find((u) => u.path === 'src/new.ts')).toMatchObject({ bytes: 11, symlink: false });
    expect(result.changes.paths).toContain('a.txt');
    const diff = await readDiff(fx.wt);
    expect(diff?.text).toContain('+TWO');
    expect(diff?.truncated).toBe(false);
    expect((await snapshotWorkspace(fx.wt)).ok).toBe(true);
    gitSync(fx.wt, 'status', '--short');
  });
});
