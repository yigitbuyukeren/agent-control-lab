import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitSync, makeWorktreeFixture } from './git-fixture.ts';
import { collectChanges, digestSigs, parseNumstatZ, parseRawZ, parseStatusZ, readDiff, snapshotWorkspace } from './git-state.ts';
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

describe('parseRawZ', () => {
  it('reads modes, status letters and paths', () => {
    const sha = 'a'.repeat(40);
    expect(parseRawZ(`:100644 120000 ${sha} ${sha} T\0link\0:000000 100644 ${sha} ${sha} A\0new file.ts\0`)).toEqual([
      { path: 'link', oldMode: '100644', newMode: '120000', status: 'T' },
      { path: 'new file.ts', oldMode: '000000', newMode: '100644', status: 'A' },
    ]);
    expect(parseRawZ('')).toEqual([]);
  });
  it('rejects malformed records', () => {
    for (const text of ['garbage\0x\0', ':100644 100644 zz zz M\0a\0', ':100644 100644 aa aa M\0']) expect(parseRawZ(text)).toBeUndefined();
  });
});

describe('digestSigs', () => {
  it('is stable regardless of key order and sensitive to any change', () => {
    expect(digestSigs({ a: '1', b: '2' })).toBe(digestSigs({ b: '2', a: '1' }));
    expect(digestSigs({ a: '1', b: '2' })).not.toBe(digestSigs({ a: '1', b: '3' }));
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
    'ls-files --others --ignored --exclude-standard --directory -z': ok(''),
  };

  it('builds a snapshot using read-only git with fsmonitor disabled', async () => {
    const { runner, specs } = runnerFor(base);
    const result = await snapshotWorkspace('/ws', { runner, platform: 'linux', env: { PATH: '/bin', GIT_DIR: '/elsewhere' } });
    expect(result).toEqual({
      ok: true,
      snapshot: { root: '/ws', head: SHA, branch: 'feature', linked: true, mainRoot: '/main', mainBranch: 'feature', refs: { feature: SHA, main: SHA }, dirty: ['a.ts'], ignored: {}, ignoredPartial: [], mainDirty: { 'a.ts': ' M:missing' } },
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
      { ...base, 'ls-files --others --ignored --exclude-standard --directory -z': { kind: 'completed', exitCode: 0, stdout: '', truncated: true } },
      { ...base, 'rev-parse --path-format=absolute --show-toplevel --git-common-dir': ok('/ws\n/ws/.git\n') },
    ];
    for (const answers of cases) {
      const { runner } = runnerFor(answers);
      const result = await snapshotWorkspace('/ws', { runner, platform: 'linux' });
      // The last case is a plain repository: readable, but not a linked worktree.
      expect(result.ok && result.snapshot.linked).not.toBe(true);
    }
    const unreadable = await Promise.all(cases.slice(0, 6).map((answers) => snapshotWorkspace('/ws', { runner: runnerFor(answers).runner, platform: 'linux' })));
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

describe('real git: ignored files, main worktree and tracked symlinks', () => {
  const fx = makeWorktreeFixture();
  afterAll(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('fingerprints ignored files and directories, which status does not list', async () => {
    writeFileSync(join(fx.main, '.gitignore'), 'dist/\n*.log\n');
    gitSync(fx.main, 'add', '.gitignore');
    gitSync(fx.main, 'commit', '-q', '-m', 'ignore');
    gitSync(fx.wt, 'merge', '-q', 'main');
    mkdirSync(join(fx.wt, 'dist', 'deep'), { recursive: true });
    writeFileSync(join(fx.wt, 'dist', 'deep', 'a.js'), 'x');
    writeFileSync(join(fx.wt, 'run.log'), 'x');
    const before = await snapshotWorkspace(fx.wt);
    expect(before.ok && before.snapshot.dirty).toEqual([]);
    const ignoredBefore = before.ok ? before.snapshot.ignored : {};
    expect(Object.keys(ignoredBefore).sort()).toEqual(['dist', 'dist/deep', 'dist/deep/a.js', 'run.log']);
    expect(before.ok && before.snapshot.ignoredPartial).toEqual([]);
    writeFileSync(join(fx.wt, 'dist', 'deep', 'a.js'), 'changed and longer');
    writeFileSync(join(fx.wt, 'dist', 'deep', 'b.js'), 'new');
    const after = await snapshotWorkspace(fx.wt);
    const ignoredAfter = after.ok ? after.snapshot.ignored : {};
    expect(ignoredAfter['dist/deep/a.js']).not.toBe(ignoredBefore['dist/deep/a.js']);
    expect(Object.keys(ignoredAfter)).toContain('dist/deep/b.js');
    expect(after.ok && after.snapshot.dirty).toEqual([]);
  });

  it('fingerprints dirty paths in the main worktree', async () => {
    writeFileSync(join(fx.main, 'wip.txt'), 'x');
    const a = await snapshotWorkspace(fx.wt);
    writeFileSync(join(fx.main, 'wip.txt'), 'longer wip');
    const b = await snapshotWorkspace(fx.wt);
    expect(a.ok && Object.keys(a.snapshot.mainDirty)).toEqual(['wip.txt']);
    expect(a.ok && b.ok && a.snapshot.mainDirty['wip.txt']).not.toBe(b.ok ? b.snapshot.mainDirty['wip.txt'] : undefined);
    rmSync(join(fx.main, 'wip.txt'));
  });

  it('reports a tracked file replaced by a symlink as a type/symlink change', async () => {
    let linked = true;
    try {
      rmSync(join(fx.wt, 'a.txt'));
      symlinkSync('.gitignore', join(fx.wt, 'a.txt'));
    } catch {
      linked = false;
    }
    if (!linked || process.platform === 'win32') return; // symlink handling depends on core.symlinks and privileges on Windows
    const result = await collectChanges(fx.wt);
    expect(result.ok && result.changes.raw).toEqual([expect.objectContaining({ path: 'a.txt', newMode: '120000' })]);
  });
});
