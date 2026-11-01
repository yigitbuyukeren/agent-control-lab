import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gitProbeEnv } from './git-preflight.ts';
import { isTaskId } from './handoff.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';
import { discoverRepoRoots } from './repo-roots.ts';
import { isProtectedBranch } from './workspace-policy.ts';

export interface WorktreeDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** What the tool remembers about a worktree it created. Only these may ever be offered for cleanup. */
export interface ManagedWorktree {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly repoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseHead: string;
  readonly createdAt: string;
}

export type WorktreePlanProblem = 'not-a-repo' | 'no-commit' | 'target-exists' | 'branch-exists' | 'target-inside-repo' | 'bad-task-id' | 'git-failed';

export type WorktreePlan =
  | { readonly ok: true; readonly taskId: string; readonly repoRoot: string; readonly path: string; readonly branch: string; readonly baseHead: string; readonly baseBranch: string | undefined }
  | { readonly ok: false; readonly problem: WorktreePlanProblem };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TIMEOUT_MS = 60_000;

async function git(cwd: string, args: readonly string[], deps: WorktreeDeps, extraConfig: readonly string[] = []): Promise<{ ok: boolean; stdout: string }> {
  const outcome = await (deps.runner ?? runProcess)({
    command: 'git',
    args: ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...extraConfig.flatMap((c) => ['-c', c]), ...args],
    cwd,
    env: gitProbeEnv(deps.env ?? process.env, ['GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']),
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: 256 * 1024,
  });
  return outcome.kind === 'completed' && outcome.exitCode === 0 ? { ok: true, stdout: outcome.stdout } : { ok: false, stdout: '' };
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/') && !rel.startsWith('\\'));
};

/**
 * Works out where a new worktree would go without touching anything. The directory lives next to the tool's own
 * data (never inside the repository), the branch is `acl/<task id>` and starts at the repository's current HEAD.
 */
export async function planWorktree(repoDir: string, taskId: string, dataDir: string, deps: WorktreeDeps = {}): Promise<WorktreePlan> {
  if (!isTaskId(taskId)) return { ok: false, problem: 'bad-task-id' };
  const roots = await discoverRepoRoots(repoDir, deps);
  if (roots.state !== 'repo') return { ok: false, problem: 'not-a-repo' };
  const repoRoot = roots.linkedFrom ?? roots.toplevel;
  const head = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], deps);
  const baseHead = head.stdout.trim();
  if (!head.ok || !SHA.test(baseHead)) return { ok: false, problem: 'no-commit' };
  const branch = `acl/${taskId}`;
  if (isProtectedBranch(branch)) return { ok: false, problem: 'git-failed' };
  const exists = await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], deps);
  if (exists.ok) return { ok: false, problem: 'branch-exists' };
  const canonicalData = await realpath(dataDir).catch(() => resolve(dataDir));
  const path = resolve(canonicalData, 'worktrees', `${basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${taskId}`);
  if (inside(repoRoot, path)) return { ok: false, problem: 'target-inside-repo' };
  if (await lstat(path).then(() => true, () => false)) return { ok: false, problem: 'target-exists' };
  const current = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], deps);
  return { ok: true, taskId, repoRoot, path, branch, baseHead, baseBranch: current.ok ? current.stdout.trim() : undefined };
}

const registryFile = (dataDir: string, taskId: string): string => join(dataDir, 'worktrees', `${taskId}.json`);

/**
 * Creates the worktree and records it. Git hooks are disabled for the call, the checkout starts from the exact
 * commit that was planned, and a failure removes only what this call made.
 */
export async function createWorktree(plan: Extract<WorktreePlan, { ok: true }>, dataDir: string, now: Date, deps: WorktreeDeps = {}): Promise<{ ok: true; worktree: ManagedWorktree } | { ok: false; problem: WorktreePlanProblem }> {
  await mkdir(dirname(plan.path), { recursive: true, mode: 0o700 });
  const emptyHooks = join(dataDir, 'worktrees', '.no-hooks');
  await mkdir(emptyHooks, { recursive: true });
  const added = await git(plan.repoRoot, ['worktree', 'add', '--no-track', '-b', plan.branch, plan.path, plan.baseHead], deps, [`core.hooksPath=${emptyHooks}`]);
  if (!added.ok) {
    // `git worktree add` cleans up after itself; make sure no half-made branch is left behind.
    const left = await git(plan.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`], deps);
    if (left.ok && left.stdout.trim() === plan.baseHead) await git(plan.repoRoot, ['branch', '-d', plan.branch], deps);
    return { ok: false, problem: 'git-failed' };
  }
  const worktree: ManagedWorktree = { schemaVersion: 1, taskId: plan.taskId, repoRoot: plan.repoRoot, path: plan.path, branch: plan.branch, baseHead: plan.baseHead, createdAt: now.toISOString() };
  const target = registryFile(dataDir, plan.taskId);
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(worktree, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
  return { ok: true, worktree };
}

export async function listManagedWorktrees(dataDir: string): Promise<ManagedWorktree[]> {
  let names: string[];
  try {
    names = await readdir(join(dataDir, 'worktrees'));
  } catch {
    return [];
  }
  const out: ManagedWorktree[] = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !isTaskId(n.slice(0, -5))) continue;
    try {
      const value = JSON.parse(await readFile(join(dataDir, 'worktrees', n), 'utf8')) as Partial<ManagedWorktree>;
      if (value.schemaVersion === 1 && typeof value.taskId === 'string' && value.taskId === n.slice(0, -5) && typeof value.path === 'string' && typeof value.repoRoot === 'string' && typeof value.branch === 'string' && typeof value.baseHead === 'string' && typeof value.createdAt === 'string' && value.branch === `acl/${value.taskId}`) out.push(value as ManagedWorktree);
    } catch {
      // a damaged registry entry is ignored, never acted on
    }
  }
  return out;
}

export type RemovalProblem = 'not-managed' | 'path-mismatch' | 'not-registered-in-git' | 'dirty' | 'branch-moved' | 'git-failed';

/**
 * Removes a worktree this tool created, after the user confirmed. Nothing is forced: a worktree with any change
 * (including untracked files) is refused. The branch is deleted only while it still points at the starting commit,
 * otherwise it is kept because it holds work.
 */
export async function removeManagedWorktree(dataDir: string, taskId: string, deps: WorktreeDeps = {}): Promise<{ ok: true; branchKept: boolean } | { ok: false; problem: RemovalProblem }> {
  const managed = (await listManagedWorktrees(dataDir)).find((w) => w.taskId === taskId);
  if (managed === undefined) return { ok: false, problem: 'not-managed' };
  const real = await realpath(managed.path).catch(() => undefined);
  const expectedRoot = await realpath(join(dataDir, 'worktrees')).catch(() => undefined);
  if (real === undefined || expectedRoot === undefined || dirname(real) !== expectedRoot) return { ok: false, problem: 'path-mismatch' };
  const list = await git(managed.repoRoot, ['worktree', 'list', '--porcelain'], deps);
  const listed = await Promise.all(list.stdout.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => realpath(l.slice(9)).catch(() => resolve(l.slice(9)))));
  const registered = listed.includes(real);
  if (!list.ok || !registered) return { ok: false, problem: 'not-registered-in-git' };
  const status = await git(managed.path, ['status', '--porcelain', '-z', '--untracked-files=all'], deps);
  if (!status.ok || status.stdout !== '') return { ok: false, problem: 'dirty' };
  const tip = (await git(managed.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${managed.branch}`], deps)).stdout.trim();
  const removed = await git(managed.repoRoot, ['worktree', 'remove', managed.path], deps);
  if (!removed.ok) return { ok: false, problem: 'git-failed' };
  let branchKept = true;
  if (tip === managed.baseHead) branchKept = !(await git(managed.repoRoot, ['branch', '-d', managed.branch], deps)).ok;
  await rm(registryFile(dataDir, taskId), { force: true });
  return { ok: true, branchKept };
}
