import { sanitize } from './codex-run.ts';
import type { WorkspaceChanges, WorkspaceSnapshot } from './git-state.ts';


/** Limits on what the implementation step may leave behind. */
export interface ChangeLimits {
  readonly maxFiles: number;
  /** Added plus deleted lines across tracked files. */
  readonly maxChangedLines: number;
  /** Size of any one new (untracked) file. */
  readonly maxNewFileBytes: number;
  /** Combined size of all new files. */
  readonly maxNewBytes: number;
}

/**
 * Sized so that a change within the limits fits the review input (`REVIEW_DIFF_CHARS`): a change
 * that is larger cannot be reviewed reliably, so it is rejected rather than reviewed in part.
 */
export const DEFAULT_LIMITS: ChangeLimits = {
  maxFiles: 25,
  maxChangedLines: 400,
  maxNewFileBytes: 20 * 1024,
  maxNewBytes: 40 * 1024,
};

/** Branches the implementation step may never run on, besides whatever the main worktree has checked out. */
const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'production', 'prod']);

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch.toLowerCase()) || /^(release|hotfix)[/-]/i.test(branch);
}

export type StartProblem =
  | 'not-a-linked-worktree'
  | 'detached-head'
  | 'protected-branch'
  | 'workspace-dirty'
  | 'ignored-coverage-partial';

export interface StartOptions {
  /** Accept that very large ignored directories (such as node_modules) are compared one level deep only. */
  readonly allowPartialIgnored?: boolean;
}

/**
 * The workspace must be an existing linked worktree on its own non-protected branch with a clean
 * tree, so every change afterwards is attributable to the implementation step and the main
 * working tree and branch are never the place that gets written to.
 */
export function checkWorkspaceStart(snapshot: WorkspaceSnapshot, options: StartOptions = {}): StartProblem[] {
  const problems: StartProblem[] = [];
  if (!snapshot.linked) problems.push('not-a-linked-worktree');
  if (snapshot.branch === undefined) problems.push('detached-head');
  else if (isProtectedBranch(snapshot.branch) || snapshot.branch === snapshot.mainBranch) problems.push('protected-branch');
  if (snapshot.dirty.length > 0) problems.push('workspace-dirty');
  if (snapshot.ignoredPartial.length > 0 && options.allowPartialIgnored !== true) problems.push('ignored-coverage-partial');
  return problems;
}

export type ChangeProblemCode =
  | 'no-changes'
  | 'head-moved'
  | 'branch-changed'
  | 'other-branch-changed'
  | 'too-many-files'
  | 'too-many-lines'
  | 'binary-change'
  | 'new-file-too-large'
  | 'new-files-too-large'
  | 'symlink-added'
  | 'symlink-change'
  | 'type-change'
  | 'mode-change'
  | 'submodule-change'
  | 'ignored-file-changed'
  | 'main-worktree-changed'
  | 'review-incomplete'
  | 'protected-path'
  | 'path-outside-workspace';

export interface ChangeProblem {
  readonly code: ChangeProblemCode;
  /** Short, sanitised, bounded; only branch names, counts or paths from git. */
  readonly detail?: string;
}

const MAX_DETAIL_PATHS = 5;

function detail(items: readonly string[]): string {
  const shown = items.slice(0, MAX_DETAIL_PATHS).map((item) => sanitize(item).slice(0, 120));
  return shown.join(', ') + (items.length > MAX_DETAIL_PATHS ? `, +${String(items.length - MAX_DETAIL_PATHS)} more` : '');
}

/** Paths whose change could alter how git, CI, credentials or the agent tooling behave. */
export function isProtectedPath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').map((s) => s.toLowerCase());
  const name = segments.at(-1) ?? '';
  if (segments.some((s) => s === '.git' || s === '.claude' || s === '.codex' || s === '.husky')) return true;
  if (segments[0] === '.github' && segments[1] === 'workflows') return true;
  if (['.gitmodules', '.gitattributes', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc', 'claude.md', 'agents.md'].includes(name)) return true;
  return name === '.env' || name.startsWith('.env.');
}

function escapesWorkspace(path: string): boolean {
  const normalised = path.replaceAll('\\', '/');
  return normalised.startsWith('/') || /^[a-z]:/i.test(normalised) || normalised.split('/').includes('..');
}

/** Keys added, removed or changed between two fingerprint maps. */
export function differing(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

/**
 * Compares the state before the implementation step with the state after it. Returns every
 * problem found; an empty list means the step stayed inside its limits. Nothing here changes
 * anything: it never reverts, commits or deletes.
 */
export function checkWorkspaceChanges(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  changes: WorkspaceChanges,
  limits: ChangeLimits = DEFAULT_LIMITS,
): ChangeProblem[] {
  const problems: ChangeProblem[] = [];
  if (after.head !== before.head) problems.push({ code: 'head-moved', detail: `${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}` });
  if (after.branch !== before.branch) {
    problems.push({ code: 'branch-changed', detail: `${before.branch ?? 'detached'} -> ${after.branch ?? 'detached'}` });
  }
  // Every other local branch (the main branch above all) must be exactly as it was.
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  const moved = [...names].filter((name) => name !== before.branch && before.refs[name] !== after.refs[name]);
  if (moved.length > 0) problems.push({ code: 'other-branch-changed', detail: detail(moved) });
  if (changes.paths.length === 0) problems.push({ code: 'no-changes' });
  if (changes.paths.length > limits.maxFiles) {
    problems.push({ code: 'too-many-files', detail: `${String(changes.paths.length)} > ${String(limits.maxFiles)}` });
  }
  const lines = changes.tracked.reduce((sum, t) => sum + (t.added ?? 0) + (t.deleted ?? 0), 0);
  if (lines > limits.maxChangedLines) problems.push({ code: 'too-many-lines', detail: `${String(lines)} > ${String(limits.maxChangedLines)}` });
  const binary = changes.tracked.filter((t) => t.added === undefined).map((t) => t.path);
  if (binary.length > 0) problems.push({ code: 'binary-change', detail: detail(binary) });
  const big = changes.untracked.filter((u) => u.bytes > limits.maxNewFileBytes).map((u) => u.path);
  if (big.length > 0) problems.push({ code: 'new-file-too-large', detail: detail(big) });
  const newBytes = changes.untracked.reduce((sum, u) => sum + u.bytes, 0);
  if (newBytes > limits.maxNewBytes) problems.push({ code: 'new-files-too-large', detail: `${String(newBytes)} > ${String(limits.maxNewBytes)} bytes` });
  const links = changes.untracked.filter((u) => u.symlink).map((u) => u.path);
  if (links.length > 0) problems.push({ code: 'symlink-added', detail: detail(links) });
  const symlinks = changes.raw.filter((r) => r.oldMode === '120000' || r.newMode === '120000').map((r) => r.path);
  if (symlinks.length > 0) problems.push({ code: 'symlink-change', detail: detail(symlinks) });
  const types = changes.raw.filter((r) => r.status === 'T').map((r) => r.path);
  if (types.length > 0) problems.push({ code: 'type-change', detail: detail(types) });
  const modes = changes.raw
    .filter((r) => r.oldMode !== r.newMode && r.oldMode !== '000000' && r.newMode !== '000000' && r.status !== 'T' && r.oldMode !== '120000' && r.newMode !== '120000')
    .map((r) => r.path);
  if (modes.length > 0) problems.push({ code: 'mode-change', detail: detail(modes) });
  const submodules = changes.raw.filter((r) => r.oldMode === '160000' || r.newMode === '160000').map((r) => r.path);
  if (submodules.length > 0) problems.push({ code: 'submodule-change', detail: detail(submodules) });
  // `git status` never lists ignored files, so they are compared by fingerprint.
  const ignored = differing(before.ignored, after.ignored);
  if (ignored.length > 0) problems.push({ code: 'ignored-file-changed', detail: detail(ignored) });
  // Writes into the main working tree (outside the sandbox) change the fingerprints of its dirty paths.
  const mainChanged = differing(before.mainDirty, after.mainDirty);
  if (mainChanged.length > 0) problems.push({ code: 'main-worktree-changed', detail: detail(mainChanged) });
  const outside = changes.paths.filter(escapesWorkspace);
  if (outside.length > 0) problems.push({ code: 'path-outside-workspace', detail: detail(outside) });
  const protectedPaths = changes.paths.filter(isProtectedPath);
  if (protectedPaths.length > 0) problems.push({ code: 'protected-path', detail: detail(protectedPaths) });
  return problems;
}

/**
 * Files that decide *what a test command runs* (scripts, build hooks, test-runner and tool
 * configuration). If the implementation step changed one, running the verification command could
 * execute whatever the model wired in, so verification is refused. This narrows the risk of
 * `--verify-command`; it does not make running newly written code safe.
 */
export function isVerifyHarnessPath(path: string): boolean {
  const name = (path.replaceAll('\\', '/').split('/').at(-1) ?? '').toLowerCase();
  const fixed = [
    'package.json', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'makefile', 'gnumakefile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini',
    'pytest.ini', 'conftest.py', 'sitecustomize.py', 'cargo.toml', 'build.rs', 'config.toml', 'go.mod', 'go.work', 'pom.xml', 'package.swift',
    'directory.build.props', 'directory.build.targets', 'global.json', 'nuget.config', 'deno.json', 'deno.jsonc', 'bunfig.toml', 'justfile', 'taskfile.yml',
  ];
  if (fixed.includes(name)) return true;
  if (/^(build|settings)\.gradle(\.kts)?$/.test(name) || /\.(mk|csproj|fsproj|vbproj|sln|targets|props)$/.test(name)) return true;
  return /^(vitest|jest|vite|mocha|babel|webpack|rollup|eslint|playwright|cypress|karma)(\.[a-z]+)?\.(config|setup)\./.test(name) || /^\.(mocharc|babelrc)/.test(name) || /\.config\.(js|cjs|mjs|ts|cts|mts|json)$/.test(name);
}

export type VerifyGateProblem = 'harness-file-changed';

/** What verification itself may not have done: moved history, touched the main tree or rewritten tracked files. */
export function checkAfterVerification(
  base: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  baseChanges: WorkspaceChanges,
  afterChanges: WorkspaceChanges,
): ChangeProblem[] {
  const problems: ChangeProblem[] = [];
  if (after.head !== base.head) problems.push({ code: 'head-moved', detail: `${base.head.slice(0, 8)} -> ${after.head.slice(0, 8)}` });
  if (after.branch !== base.branch) problems.push({ code: 'branch-changed', detail: `${base.branch ?? 'detached'} -> ${after.branch ?? 'detached'}` });
  const names = new Set([...Object.keys(base.refs), ...Object.keys(after.refs)]);
  const moved = [...names].filter((name) => name !== base.branch && base.refs[name] !== after.refs[name]);
  if (moved.length > 0) problems.push({ code: 'other-branch-changed', detail: detail(moved) });
  const mainChanged = differing(base.mainDirty, after.mainDirty);
  if (mainChanged.length > 0) problems.push({ code: 'main-worktree-changed', detail: detail(mainChanged) });
  const key = (c: WorkspaceChanges) => JSON.stringify(c.tracked) + JSON.stringify(c.raw);
  if (key(baseChanges) !== key(afterChanges)) problems.push({ code: 'review-incomplete', detail: 'tracked files changed during verification' });
  const newProtected = afterChanges.paths.filter((p) => !baseChanges.paths.includes(p) && isProtectedPath(p));
  if (newProtected.length > 0) problems.push({ code: 'protected-path', detail: detail(newProtected) });
  return problems;
}
