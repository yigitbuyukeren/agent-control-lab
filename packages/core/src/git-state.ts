import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitize } from './codex-run.ts';
import { gitProbeEnv } from './git-preflight.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';
import { discoverRepoRoots } from './repo-roots.ts';

/** How read-only git is run; everything here only reads. */
export interface GitReadDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_OUTPUT_BYTES = 256 * 1024;
/** Cap on the diff text kept for review and display. */
export const MAX_DIFF_BYTES = 64 * 1024;

type GitResult = { readonly ok: true; readonly stdout: string; readonly truncated: boolean } | { readonly ok: false; readonly exitCode?: number | null };

/**
 * One read-only git call. `--no-optional-locks` keeps `status` from refreshing the index and
 * `core.fsmonitor=false` keeps a repository-configured monitor command from running.
 */
async function git(cwd: string, args: readonly string[], deps: GitReadDeps, maxOutputBytes = GIT_OUTPUT_BYTES): Promise<GitResult> {
  const outcome = await (deps.runner ?? runProcess)({
    command: 'git',
    args: ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    cwd,
    env: gitProbeEnv(deps.env ?? process.env, ['GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']),
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes,
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  if (outcome.kind !== 'completed') return { ok: false };
  if (outcome.exitCode !== 0) return { ok: false, exitCode: outcome.exitCode };
  return { ok: true, stdout: outcome.stdout, truncated: outcome.truncated };
}

export interface StatusEntry {
  readonly x: string;
  readonly y: string;
  readonly path: string;
}

/** Parses `git status --porcelain=v1 -z`; `undefined` if the text is not in that format. */
export function parseStatusZ(text: string): StatusEntry[] | undefined {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i] ?? '';
    if (record.length < 4 || record[2] !== ' ') return undefined;
    const x = record.slice(0, 1);
    const y = record.slice(1, 2);
    entries.push({ x, y, path: record.slice(3) });
    // Renames and copies carry the original path as an extra record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
  }
  return entries;
}

export interface NumstatEntry {
  readonly path: string;
  /** `undefined` for a binary file. */
  readonly added: number | undefined;
  readonly deleted: number | undefined;
}

/** Parses `git diff --numstat -z --no-renames`; `undefined` if malformed. */
export function parseNumstatZ(text: string): NumstatEntry[] | undefined {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries: NumstatEntry[] = [];
  for (const record of parts) {
    const first = record.indexOf('\t');
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
    if (second < 0) return undefined;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (path === '' || !/^(\d+|-)$/.test(added) || !/^(\d+|-)$/.test(deleted)) return undefined;
    entries.push({
      path,
      added: added === '-' ? undefined : Number(added),
      deleted: deleted === '-' ? undefined : Number(deleted),
    });
  }
  return entries;
}

/** State of an isolated Git worktree at one moment. Branch refs are compared before and after. */
export interface WorkspaceSnapshot {
  readonly root: string;
  readonly head: string;
  /** `undefined` when HEAD is detached. */
  readonly branch: string | undefined;
  /** A linked worktree of a repository whose main worktree could be located. */
  readonly linked: boolean;
  readonly mainRoot: string | undefined;
  /** Branch checked out in the main worktree, if any. */
  readonly mainBranch: string | undefined;
  /** Every local branch and the commit it points to. */
  readonly refs: Readonly<Record<string, string>>;
  /** Paths git reports as modified, staged or untracked. */
  readonly dirty: readonly string[];
}

export type SnapshotResult = { readonly ok: true; readonly snapshot: WorkspaceSnapshot } | { readonly ok: false };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function parseRefs(text: string): Record<string, string> | undefined {
  const refs: Record<string, string> = {};
  for (const line of text.split('\n').filter((l) => l !== '')) {
    const [name, sha, extra] = line.split('\0');
    if (name === undefined || sha === undefined || extra !== undefined || !SHA.test(sha)) return undefined;
    refs[name] = sha;
  }
  return refs;
}

/** Reads the workspace state with read-only git calls. Any unexpected answer fails closed. */
export async function snapshotWorkspace(cwd: string, deps: GitReadDeps = {}): Promise<SnapshotResult> {
  const roots = await discoverRepoRoots(cwd, {
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  if (roots.state !== 'repo') return { ok: false };
  const [head, branch, status, refs] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD'], deps),
    git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], deps),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deps),
    git(cwd, ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'], deps),
  ]);
  if (!head.ok || !status.ok || status.truncated || !refs.ok || refs.truncated) return { ok: false };
  const headSha = head.stdout.trim();
  // `symbolic-ref -q` exits 1 for a detached HEAD; any other failure is unknown.
  if (!branch.ok && branch.exitCode !== 1) return { ok: false };
  const entries = parseStatusZ(status.stdout);
  const refMap = parseRefs(refs.stdout);
  if (!SHA.test(headSha) || entries === undefined || refMap === undefined) return { ok: false };
  let mainBranch: string | undefined;
  if (roots.linkedFrom !== undefined) {
    const main = await git(roots.linkedFrom, ['symbolic-ref', '-q', '--short', 'HEAD'], deps);
    if (main.ok) mainBranch = main.stdout.trim() || undefined;
    else if (main.exitCode !== 1) return { ok: false };
  }
  return {
    ok: true,
    snapshot: {
      root: roots.toplevel,
      head: headSha,
      branch: branch.ok ? branch.stdout.trim() : undefined,
      linked: roots.linkedFrom !== undefined,
      mainRoot: roots.linkedFrom,
      mainBranch,
      refs: refMap,
      dirty: entries.map((e) => e.path),
    },
  };
}

export interface UntrackedFile {
  readonly path: string;
  readonly bytes: number;
  readonly symlink: boolean;
}

export interface WorkspaceChanges {
  readonly tracked: readonly NumstatEntry[];
  readonly untracked: readonly UntrackedFile[];
  /** Paths that are staged/modified/deleted/untracked, from `status`. */
  readonly paths: readonly string[];
}

export type ChangesResult = { readonly ok: true; readonly changes: WorkspaceChanges } | { readonly ok: false };

/** Changes against HEAD: tracked files by `diff --numstat`, new files by `status`. */
export async function collectChanges(root: string, deps: GitReadDeps = {}): Promise<ChangesResult> {
  const [numstat, status] = await Promise.all([
    git(root, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD'], deps),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deps),
  ]);
  if (!numstat.ok || numstat.truncated || !status.ok || status.truncated) return { ok: false };
  const tracked = parseNumstatZ(numstat.stdout);
  const entries = parseStatusZ(status.stdout);
  if (tracked === undefined || entries === undefined) return { ok: false };
  const untracked: UntrackedFile[] = [];
  for (const entry of entries.filter((e) => e.x === '?')) {
    try {
      const info = await lstat(join(root, entry.path));
      untracked.push({ path: entry.path, bytes: info.size, symlink: info.isSymbolicLink() });
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, changes: { tracked, untracked, paths: [...new Set([...tracked.map((t) => t.path), ...entries.map((e) => e.path)])] } };
}

/** Text diff of tracked files against HEAD with external diff and textconv programs disabled. */
export async function readDiff(root: string, deps: GitReadDeps = {}): Promise<{ text: string; truncated: boolean } | undefined> {
  const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'], deps, MAX_DIFF_BYTES);
  return diff.ok ? { text: sanitize(diff.stdout), truncated: diff.truncated } : undefined;
}
