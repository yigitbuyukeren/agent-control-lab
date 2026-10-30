import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';
import { discoverRepoRoots, projectSettingsDirs } from './repo-roots.ts';

const done = (stdout: string, exitCode = 0): ProcessOutcome => ({ kind: 'completed', exitCode, stdout, truncated: false });

async function discover(outcome: ProcessOutcome, platform: NodeJS.Platform = 'linux') {
  const specs: ProcessSpec[] = [];
  const roots = await discoverRepoRoots('/w', {
    platform,
    env: { PATH: '/bin', GIT_DIR: '/elsewhere', git_common_dir: '/x', GIT_CEILING_DIRECTORIES: '/' },
    runner: (spec) => {
      specs.push(spec);
      return Promise.resolve(outcome);
    },
  });
  return { roots, spec: specs[0] as ProcessSpec };
}

describe('discoverRepoRoots', () => {
  it('asks git read-only with a hardened environment', async () => {
    const { spec } = await discover(done('/r\n/r/.git\n'));
    expect(spec).toMatchObject({ command: 'git', args: ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], cwd: '/w' });
    expect(spec.env).toEqual({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  });

  it('reports a plain repository and a linked worktree', async () => {
    expect((await discover(done('/r\n/r/.git\n'))).roots).toEqual({ state: 'repo', toplevel: '/r' });
    expect((await discover(done('/wt\n/main/.git\n'))).roots).toEqual({ state: 'repo', toplevel: '/wt', linkedFrom: '/main' });
    // A submodule's common dir is not a `.git` directory, so no main root is guessed.
    expect((await discover(done('/sup/sub\n/sup/.git/modules/sub\n'))).roots).toEqual({ state: 'repo', toplevel: '/sup/sub' });
  });

  it('normalises git forward-slash paths on Windows', async () => {
    const { roots } = await discover(done('C:/Users/u/wt\nC:/Users/u/main/.git\r\n'), 'win32');
    expect(roots).toEqual({ state: 'repo', toplevel: 'C:\\Users\\u\\wt', linkedFrom: 'C:\\Users\\u\\main' });
  });

  it('keeps "not a repository" apart from "could not tell"', async () => {
    expect((await discover(done('', 128))).roots).toEqual({ state: 'not-a-repo' });
    for (const outcome of [done('', 129), done('', 1), done('/r\n'), done('rel\n/r/.git\n'), done('/r\n/r/.git\nextra\n'), { kind: 'not-found' }, { kind: 'timeout' }, { kind: 'spawn-failed' }, { kind: 'cancelled' }] as ProcessOutcome[]) {
      expect((await discover(outcome)).roots).toEqual({ state: 'unresolved' });
    }
  });
});

describe('projectSettingsDirs', () => {
  const repo = { state: 'repo', toplevel: '/r' } as const;

  it('walks from the working directory up to the repository root', () => {
    expect(projectSettingsDirs('/r', repo, 'linux')).toEqual(['/r']);
    expect(projectSettingsDirs('/r/a/b', repo, 'linux')).toEqual(['/r/a/b', '/r/a', '/r']);
  });

  it('adds the main worktree root for a linked worktree', () => {
    expect(projectSettingsDirs('/wt/x', { state: 'repo', toplevel: '/wt', linkedFrom: '/main' }, 'linux')).toEqual(['/wt/x', '/wt', '/main']);
  });

  it('uses only the working directory outside a repository', () => {
    expect(projectSettingsDirs('/plain', { state: 'not-a-repo' }, 'linux')).toEqual(['/plain']);
  });

  it('fails closed when unresolved or when the directory is not under the root', () => {
    expect(projectSettingsDirs('/r', { state: 'unresolved' }, 'linux')).toBeUndefined();
    expect(projectSettingsDirs('/other', repo, 'linux')).toBeUndefined();
    expect(projectSettingsDirs('/r/../x', repo, 'linux')).toBeUndefined();
  });

  it('works with Windows paths, case-insensitively', () => {
    const win = { state: 'repo', toplevel: 'C:\\Repo', linkedFrom: 'D:\\Main' } as const;
    expect(projectSettingsDirs('c:\\repo\\a', win, 'win32')).toEqual(['c:\\repo\\a', 'c:\\repo', 'D:\\Main']);
    expect(projectSettingsDirs('D:\\elsewhere', win, 'win32')).toBeUndefined();
  });
});

describe('discoverRepoRoots (real git)', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl roots ')));
  const git = (cwd: string, ...args: string[]) => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
  };
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the root from a subdirectory and the main root from a linked worktree', async () => {
    const main = join(dir, 'main');
    const linked = join(dir, 'linked');
    mkdirSync(join(main, 'sub'), { recursive: true });
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', linked);
    const fromSub = await discoverRepoRoots(join(main, 'sub'));
    expect(fromSub).toEqual({ state: 'repo', toplevel: main });
    expect(projectSettingsDirs(join(main, 'sub'), fromSub)).toEqual([join(main, 'sub'), main]);
    const fromLinked = await discoverRepoRoots(linked);
    expect(fromLinked).toEqual({ state: 'repo', toplevel: linked, linkedFrom: main });
    expect(projectSettingsDirs(linked, fromLinked)).toEqual([linked, main]);
  });
});
