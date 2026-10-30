import { describe, expect, it } from 'vitest';
import type { WorkspaceChanges, WorkspaceSnapshot } from './git-state.ts';
import { DEFAULT_LIMITS, checkAfterVerification, checkWorkspaceChanges, checkWorkspaceStart, differing, isProtectedBranch, isProtectedPath, isVerifyHarnessPath } from './workspace-policy.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function snap(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    root: '/ws', head: SHA_A, branch: 'feature', linked: true, mainRoot: '/main', mainBranch: 'main',
    refs: { main: SHA_A, feature: SHA_A }, dirty: [], ignored: {}, ignoredPartial: [], dirtySigs: {}, mainDirty: {}, ...over,
  };
}

function changes(over: Partial<WorkspaceChanges> = {}): WorkspaceChanges {
  const tracked = over.tracked ?? [{ path: 'src/a.ts', added: 3, deleted: 1 }];
  return { tracked, raw: [], untracked: [], paths: tracked.map((t) => t.path), ...over };
}

const codes = (before: WorkspaceSnapshot, after: WorkspaceSnapshot, c: WorkspaceChanges, limits = DEFAULT_LIMITS) =>
  checkWorkspaceChanges(before, after, c, limits).map((p) => p.code);

describe('checkWorkspaceStart', () => {
  it('accepts a clean linked worktree on its own branch', () => {
    expect(checkWorkspaceStart(snap())).toEqual([]);
  });

  it('rejects the main working tree, detached HEAD, protected branches and dirty trees', () => {
    expect(checkWorkspaceStart(snap({ linked: false, mainRoot: undefined, mainBranch: undefined }))).toEqual(['not-a-linked-worktree']);
    expect(checkWorkspaceStart(snap({ branch: undefined }))).toEqual(['detached-head']);
    for (const branch of ['main', 'MASTER', 'develop', 'release/1.2', 'hotfix-3', 'production']) {
      expect(checkWorkspaceStart(snap({ branch }))).toEqual(['protected-branch']);
    }
    expect(checkWorkspaceStart(snap({ branch: 'work', mainBranch: 'work' }))).toEqual(['protected-branch']);
    expect(checkWorkspaceStart(snap({ dirty: ['x.txt'] }))).toEqual(['workspace-dirty']);
  });

  it('reports every problem at once', () => {
    expect(checkWorkspaceStart(snap({ linked: false, branch: 'main', dirty: ['x'] }))).toEqual(['not-a-linked-worktree', 'protected-branch', 'workspace-dirty']);
  });

  it('knows protected branch names', () => {
    expect(isProtectedBranch('feature/x')).toBe(false);
    expect(isProtectedBranch('release/x')).toBe(true);
    expect(isProtectedBranch('releases')).toBe(false);
  });
});

describe('checkWorkspaceChanges', () => {
  it('accepts a small change that leaves branches and HEAD alone', () => {
    expect(codes(snap(), snap(), changes())).toEqual([]);
  });

  it('flags no changes at all', () => {
    expect(codes(snap(), snap(), changes({ tracked: [], paths: [] }))).toEqual(['no-changes']);
  });

  it('flags a commit, a branch switch and any other branch moving (the main branch above all)', () => {
    expect(codes(snap(), snap({ head: SHA_B, refs: { main: SHA_A, feature: SHA_B } }), changes())).toEqual(['head-moved']);
    expect(codes(snap(), snap({ branch: 'other', refs: { main: SHA_A, feature: SHA_A, other: SHA_A } }), changes())).toEqual(['branch-changed', 'other-branch-changed']);
    const moved = checkWorkspaceChanges(snap(), snap({ refs: { main: SHA_B, feature: SHA_A } }), changes());
    expect(moved).toEqual([{ code: 'other-branch-changed', detail: 'main' }]);
    expect(codes(snap(), snap({ refs: { feature: SHA_A } }), changes())).toEqual(['other-branch-changed']);
  });

  it('enforces the size limits', () => {
    const many = Array.from({ length: DEFAULT_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${String(i)}.ts`, added: 1, deleted: 0 }));
    expect(codes(snap(), snap(), changes({ tracked: many, paths: many.map((m) => m.path) }))).toEqual(['too-many-files']);
    const big = [{ path: 'a.ts', added: DEFAULT_LIMITS.maxChangedLines, deleted: 1 }];
    expect(codes(snap(), snap(), changes({ tracked: big, paths: ['a.ts'] }))).toEqual(['too-many-lines']);
    const limits = { ...DEFAULT_LIMITS, maxNewFileBytes: 10, maxNewBytes: 15 };
    const untracked = [{ path: 'n1', bytes: 11, symlink: false }, { path: 'n2', bytes: 8, symlink: false }];
    expect(codes(snap(), snap(), changes({ tracked: [], untracked, paths: ['n1', 'n2'] }), limits)).toEqual(['new-file-too-large', 'new-files-too-large']);
  });

  it('flags binary files, symlinks and paths that escape the workspace', () => {
    expect(codes(snap(), snap(), changes({ tracked: [{ path: 'x.png', added: undefined, deleted: undefined }], paths: ['x.png'] }))).toEqual(['binary-change']);
    expect(codes(snap(), snap(), changes({ tracked: [], untracked: [{ path: 'link', bytes: 3, symlink: true }], paths: ['link'] }))).toEqual(['symlink-added']);
    for (const path of ['../x', '/etc/passwd', 'C:\\x', 'a/../../b']) {
      expect(codes(snap(), snap(), changes({ tracked: [{ path, added: 1, deleted: 0 }], paths: [path] }))).toContain('path-outside-workspace');
    }
  });

  it('flags protected paths and keeps details short and clean', () => {
    const paths = ['.github/workflows/ci.yml', '.git/hooks/pre-commit', '.env.local', 'sub/.claude/settings.json', '.npmrc', 'CLAUDE.md', '.claude/\u001b[31mx'];
    const result = checkWorkspaceChanges(snap(), snap(), changes({ tracked: paths.map((path) => ({ path, added: 1, deleted: 0 })), paths }));
    const found = result.find((p) => p.code === 'protected-path');
    expect(found?.detail).toContain('.github/workflows/ci.yml');
    expect(found?.detail).toContain('+2 more');
    expect(found?.detail).not.toContain('\u001b');
  });

  it('only treats real protected paths as protected', () => {
    for (const path of ['.github/workflows/ci.yml', '.git/config', 'a/.git/x', '.env', '.env.production', '.claude/x', '.codex/x', '.husky/pre-commit', '.gitmodules', '.gitattributes', 'AGENTS.md', 'win\\.git\\config']) {
      expect(isProtectedPath(path)).toBe(true);
    }
    for (const path of ['src/environment.ts', '.github/ISSUE_TEMPLATE/a.md', 'docs/claude-notes.md', '.gitignore', 'envfile']) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });
});

const raw = (path: string, oldMode: string, newMode: string, status = 'M') => ({ path, oldMode, newMode, status });

describe('checkWorkspaceChanges: ignored files, main worktree and file types', () => {
  it('flags ignored files that appear, disappear or change, which git status never shows', () => {
    const before = snap({ ignored: { 'dist/a.js': 'f:1:1', '.cache/x': 'f:2:2', gone: 'f:3:3' } });
    const after = snap({ ignored: { 'dist/a.js': 'f:9:1', '.cache/x': 'f:2:2', fresh: 'f:1:1' } });
    const result = checkWorkspaceChanges(before, after, changes());
    expect(result).toEqual([{ code: 'ignored-file-changed', detail: 'dist/a.js, fresh, gone' }]);
    expect(codes(before, before, changes())).toEqual([]);
  });

  it('flags writes into the main worktree', () => {
    const before = snap({ mainDirty: { 'wip.txt': ' M:f:3:1' } });
    expect(codes(before, snap({ mainDirty: { 'wip.txt': ' M:f:9:1' } }), changes())).toEqual(['main-worktree-changed']);
    expect(codes(before, snap({ mainDirty: { 'wip.txt': ' M:f:3:1', 'new.txt': '??:f:1:1' } }), changes())).toEqual(['main-worktree-changed']);
    expect(codes(before, snap({ mainDirty: {} }), changes())).toEqual(['main-worktree-changed']);
  });

  it('flags tracked symlinks (added, changed, removed), type changes, exec-bit changes and submodules', () => {
    const cases: [ReturnType<typeof raw>, string][] = [
      [raw('l', '000000', '120000', 'A'), 'symlink-change'],
      [raw('l', '100644', '120000', 'T'), 'symlink-change'],
      [raw('l', '120000', '120000'), 'symlink-change'],
      [raw('l', '120000', '000000', 'D'), 'symlink-change'],
      [raw('t', '100644', '040000', 'T'), 'type-change'],
      [raw('x.sh', '100644', '100755'), 'mode-change'],
      [raw('sub', '160000', '160000'), 'submodule-change'],
    ];
    for (const [r, code] of cases) {
      const found = codes(snap(), snap(), changes({ raw: [r] }));
      expect(found).toContain(code);
    }
    expect(codes(snap(), snap(), changes({ raw: [raw('a.ts', '100644', '100644')] }))).toEqual([]);
    expect(codes(snap(), snap(), changes({ raw: [raw('new', '000000', '100644', 'A')] }))).toEqual([]);
    expect(codes(snap(), snap(), changes({ raw: [raw('x.sh', '100644', '100755')] }))).toEqual(['mode-change']);
  });

  it('compares fingerprint maps', () => {
    expect(differing({ a: '1', b: '2' }, { a: '1', b: '3', c: '1' })).toEqual(['b', 'c']);
    expect(differing({}, {})).toEqual([]);
  });
});

describe('checkWorkspaceStart: ignored coverage', () => {
  it('fails closed on partially covered ignored directories unless explicitly accepted', () => {
    const partial = snap({ ignoredPartial: ['node_modules/'] });
    expect(checkWorkspaceStart(partial)).toEqual(['ignored-coverage-partial']);
    expect(checkWorkspaceStart(partial, { allowPartialIgnored: false })).toEqual(['ignored-coverage-partial']);
    expect(checkWorkspaceStart(partial, { allowPartialIgnored: true })).toEqual([]);
  });
});

describe('isVerifyHarnessPath', () => {
  it('recognises files that decide what a test or build command runs', () => {
    for (const path of ['package.json', 'sub/package.json', 'Makefile', 'pyproject.toml', 'conftest.py', 'tests/conftest.py', 'Cargo.toml', 'build.rs', '.cargo/config.toml', 'vitest.config.ts', 'jest.config.js', 'vite.config.mts', 'webpack.config.cjs', 'build.gradle.kts', 'app.csproj', 'Directory.Build.props', '.mocharc.json', 'x\\package.json']) {
      expect(isVerifyHarnessPath(path)).toBe(true);
    }
    for (const path of ['src/a.ts', 'tests/a.test.ts', 'README.md', 'docs/package-notes.md', 'lib/config.ts', 'src/build.ts']) {
      expect(isVerifyHarnessPath(path)).toBe(false);
    }
  });
});

describe('checkAfterVerification', () => {
  const same = changes({ raw: [] });
  it('accepts a verification that only produced output', () => {
    expect(checkAfterVerification(snap(), snap(), same, { ...same, untracked: [{ path: 'coverage/x', bytes: 1, symlink: false }], paths: [...same.paths, 'coverage/x'] })).toEqual([]);
  });
  it('flags moved history, a changed main worktree, rewritten tracked files and new protected paths', () => {
    const result = checkAfterVerification(
      snap(),
      snap({ head: SHA_B, refs: { main: SHA_B, feature: SHA_B }, mainDirty: { x: '??:f:1:1' } }),
      same,
      { ...same, tracked: [{ path: 'src/a.ts', added: 9, deleted: 1 }], paths: [...same.paths, '.github/workflows/x.yml'] },
    );
    expect(result.map((p) => p.code)).toEqual(['head-moved', 'other-branch-changed', 'main-worktree-changed', 'review-incomplete', 'protected-path']);
  });
});
