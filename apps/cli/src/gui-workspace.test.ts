import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitWorkspaceProbe } from './gui-workspace.ts';

let root = '';
let main = '';
let wt = '';
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl ws ')));
  main = join(root, 'main');
  wt = join(root, 'wt');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'one\ntwo\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gitWorkspaceProbe', () => {
  it('fingerprints the state, so any change after the preview is noticed', async () => {
    const probe = gitWorkspaceProbe();
    const a = await probe.read(wt);
    expect(a?.branch).toBe('feature');
    expect((await probe.read(wt))?.fingerprint).toBe(a?.fingerprint);
    writeFileSync(join(wt, 'x.txt'), '1');
    expect((await probe.read(wt))?.fingerprint).not.toBe(a?.fingerprint);
    expect(await probe.read(join(root, 'nope'))).toBeUndefined();
  });

  it('reports the real changes and flags a commit made during the run', async () => {
    const probe = gitWorkspaceProbe();
    const before = await probe.read(wt);
    writeFileSync(join(wt, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt, 'new.ts'), 'export {};\n');
    const r = await probe.report(wt, before);
    expect(r).toMatchObject({ readable: true, committed: false, branch: 'feature', added: 2, deleted: 1 });
    expect(r.files).toEqual(expect.arrayContaining([{ path: 'a.txt', kind: 'changed', added: 2, deleted: 1 }, { path: 'new.ts', kind: 'new', bytes: 11 }]));
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'sneaky');
    const after = await probe.report(wt, before);
    expect(after.committed).toBe(true);
    expect(after.headAfter).not.toBe(after.headBefore);
  });

  it('says so when the state cannot be read', async () => {
    const r = await gitWorkspaceProbe().report(join(root, 'nope'), undefined);
    expect(r).toMatchObject({ readable: false, files: [] });
  });
});
