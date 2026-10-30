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

export const DEFAULT_LIMITS: ChangeLimits = {
  maxFiles: 40,
  maxChangedLines: 1500,
  maxNewFileBytes: 100 * 1024,
  maxNewBytes: 300 * 1024,
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
  | 'workspace-dirty';

/**
 * The workspace must be an existing linked worktree on its own non-protected branch with a clean
 * tree, so every change afterwards is attributable to the implementation step and the main
 * working tree and branch are never the place that gets written to.
 */
export function checkWorkspaceStart(snapshot: WorkspaceSnapshot): StartProblem[] {
  const problems: StartProblem[] = [];
  if (!snapshot.linked) problems.push('not-a-linked-worktree');
  if (snapshot.branch === undefined) problems.push('detached-head');
  else if (isProtectedBranch(snapshot.branch) || snapshot.branch === snapshot.mainBranch) problems.push('protected-branch');
  if (snapshot.dirty.length > 0) problems.push('workspace-dirty');
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
  const outside = changes.paths.filter(escapesWorkspace);
  if (outside.length > 0) problems.push({ code: 'path-outside-workspace', detail: detail(outside) });
  const protectedPaths = changes.paths.filter(isProtectedPath);
  if (protectedPaths.length > 0) problems.push({ code: 'protected-path', detail: detail(protectedPaths) });
  return problems;
}
