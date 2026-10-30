import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Test helper: runs real git with a fixed identity and no signing or hooks. */
export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/** A scratch repository on `main` with one commit and a linked worktree `wt` on branch `feature`. */
export function makeWorktreeFixture(): { root: string; main: string; wt: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl ws ')));
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  mkdirSync(main);
  gitSync(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'one\ntwo\n');
  gitSync(main, 'add', 'a.txt');
  gitSync(main, 'commit', '-q', '-m', 'init');
  gitSync(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { root, main, wt };
}
