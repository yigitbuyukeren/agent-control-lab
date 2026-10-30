import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkGitRepo } from './git-preflight.ts';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';

describe('checkGitRepo (mock runner)', () => {
  const check = async (outcome: ProcessOutcome) => {
    const specs: ProcessSpec[] = [];
    const state = await checkGitRepo('/work', {
      runner: (s) => {
        specs.push(s);
        return Promise.resolve(outcome);
      },
      env: { PATH: '/bin', GIT_DIR: '/elsewhere', git_work_tree: '/x' },
    });
    return { state, spec: specs[0] as ProcessSpec };
  };

  it('asks git read-only with a hardened environment', async () => {
    const { spec } = await check({ kind: 'completed', exitCode: 0, stdout: 'true\n', truncated: false });
    expect(spec).toMatchObject({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: '/work' });
    expect(spec.env).toEqual({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  });

  it('maps outcomes to distinct states', async () => {
    expect((await check({ kind: 'completed', exitCode: 0, stdout: 'true\n', truncated: false })).state).toBe('repo');
    expect((await check({ kind: 'completed', exitCode: 128, stdout: '', truncated: false })).state).toBe('not-a-repo');
    expect((await check({ kind: 'completed', exitCode: 0, stdout: 'false\n', truncated: false })).state).toBe('not-a-repo');
    expect((await check({ kind: 'not-found' })).state).toBe('git-not-installed');
    expect((await check({ kind: 'timeout' })).state).toBe('check-failed');
    expect((await check({ kind: 'spawn-failed' })).state).toBe('check-failed');
    expect((await check({ kind: 'cancelled' })).state).toBe('check-failed');
  });
});

describe('checkGitRepo (real git)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acl git ')));
  // Keep git from walking up into an unrelated repository that happens to contain tmpdir.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a plain directory as not-a-repo and never initialises it', async () => {
    expect(await checkGitRepo(dir, { env })).toBe('not-a-repo');
    expect(await checkGitRepo(dir, { env })).toBe('not-a-repo');
  });

  it('recognises a repository (test fixture created with git init)', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, env, stdio: 'ignore' });
    expect(await checkGitRepo(dir, { env })).toBe('repo');
  });

  it('reports git-not-installed when git is not on PATH', async () => {
    const empty = join(dir, 'nothing');
    expect(await checkGitRepo(dir, { env: { ...env, PATH: empty, Path: empty } })).toBe('git-not-installed');
  });
});
