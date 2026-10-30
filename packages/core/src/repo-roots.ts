import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { gitProbeEnv } from './git-preflight.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';

/**
 * Where a working directory sits in Git, from read-only `git rev-parse`. `linkedFrom` is the main
 * worktree root when `toplevel` is a linked worktree. `unresolved` means git could not answer
 * reliably (missing, timed out, unexpected output); callers must not treat it as "not a repo".
 */
export type RepoRoots =
  | { readonly state: 'repo'; readonly toplevel: string; readonly linkedFrom?: string }
  | { readonly state: 'not-a-repo' }
  | { readonly state: 'unresolved' };

const TIMEOUT_MS = 5000;

export async function discoverRepoRoots(
  cwd: string,
  options: {
    readonly runner?: ProcessRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<RepoRoots> {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const outcome = await (options.runner ?? runProcess)({
    command: 'git',
    args: ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    cwd,
    // A ceiling or common-dir override could hide the real root, which would shrink the scan.
    env: gitProbeEnv(options.env ?? process.env, ['GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']),
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: 8192,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  if (outcome.kind !== 'completed') return { state: 'unresolved' };
  // 128 is git's "not a repository / not a work tree"; anything else non-zero (old git without
  // --path-format exits 129) is unknown, not "no repository".
  if (outcome.exitCode === 128) return { state: 'not-a-repo' };
  if (outcome.exitCode !== 0) return { state: 'unresolved' };
  const lines = outcome.stdout.split(/\r?\n/).filter((line) => line !== '');
  const [top, common] = lines;
  if (lines.length !== 2 || top === undefined || common === undefined || !path.isAbsolute(top) || !path.isAbsolute(common)) {
    return { state: 'unresolved' };
  }
  const toplevel = path.normalize(top);
  const commonDir = path.normalize(common);
  const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : undefined;
  return {
    state: 'repo',
    toplevel,
    ...(mainRoot !== undefined && mainRoot !== toplevel ? { linkedFrom: mainRoot } : {}),
  };
}

/**
 * Directories whose `.claude/settings*.json` may apply: the working directory, every directory up
 * to the repository root, and the main worktree root for a linked worktree. `undefined` when the
 * working directory is not under the reported root (for example an unresolved symlink), so the
 * caller fails closed instead of guessing.
 */
export function projectSettingsDirs(
  cwd: string,
  roots: RepoRoots,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const path = platform === 'win32' ? win32 : posix;
  if (roots.state === 'unresolved') return undefined;
  if (roots.state === 'not-a-repo') return [cwd];
  const relative = path.relative(roots.toplevel, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.relative(roots.toplevel, dir) === '') break;
    if (path.dirname(dir) === dir) return undefined;
  }
  if (roots.linkedFrom !== undefined) dirs.push(roots.linkedFrom);
  return dirs;
}

/** `cwd` with symlinks resolved, or `undefined` if it cannot be (so it cannot be related to git's paths). */
export async function realCwd(cwd: string): Promise<string | undefined> {
  try {
    return await realpath(cwd);
  } catch {
    return undefined;
  }
}
