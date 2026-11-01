import { createWorktree, listManagedWorktrees, newTaskId, planWorktree, removeManagedWorktree, isTaskId, type WorktreeDeps } from '@agent-control-lab/core';
import { resolve } from 'node:path';
import { safeText } from './workspaces.ts';

export const WORKTREE_USAGE = [
  'usage: agent-control-lab worktree create --repo <dir> [--task <id>] [--confirm]   (without --confirm only shows the plan)',
  '       agent-control-lab worktree list',
  '       agent-control-lab worktree remove <task id> --confirm   (only worktrees this tool created; refuses any change in them)',
].join('\n');

interface Io {
  out(t: string): void;
  error(t: string): void;
}

const WHY: Record<string, string> = {
  'not-a-repo': 'the folder is not inside a Git repository',
  'no-commit': 'the repository has no commit to start from',
  'target-exists': 'the target folder already exists',
  'branch-exists': 'the branch already exists',
  'target-inside-repo': 'the data directory is inside the repository',
  'bad-task-id': 'the task id is not valid',
  'git-failed': 'git could not create the worktree',
  'not-managed': 'this tool did not create such a worktree; it will not touch it',
  'path-mismatch': 'the recorded folder is not where the tool created it',
  'not-registered-in-git': 'git no longer lists that worktree',
  dirty: 'the worktree has changes; commit or discard them yourself first',
  'branch-moved': 'the branch moved',
};

export async function runWorktreeCommand(argv: readonly string[], io: Io, dataDir: string | undefined, deps: WorktreeDeps = {}, now: () => Date = () => new Date()): Promise<number> {
  if (dataDir === undefined) {
    io.error('worktree: no local data directory is available\n');
    return 1;
  }
  const [sub, ...rest] = argv;
  if (sub === 'list' && rest.length === 0) {
    const all = await listManagedWorktrees(dataDir);
    io.out(all.length === 0 ? 'no worktrees created by this tool\n' : all.map((w) => `${w.taskId}  ${w.branch}  ${safeText(w.path)}  (from ${safeText(w.repoRoot)})\n`).join(''));
    return 0;
  }
  if (sub === 'remove') {
    const id = rest.find((a) => !a.startsWith('--'));
    if (id === undefined || !isTaskId(id) || rest.some((a) => a !== id && a !== '--confirm')) {
      io.error(`${WORKTREE_USAGE}\n`);
      return 2;
    }
    if (!rest.includes('--confirm')) {
      io.out(`would remove the worktree and, if it holds no commits, the branch of ${id}; add --confirm to do it\n`);
      return 0;
    }
    const out = await removeManagedWorktree(dataDir, id, deps);
    if (!out.ok) {
      io.error(`worktree: not removed: ${WHY[out.problem] ?? out.problem}\n`);
      return 1;
    }
    io.out(`removed the worktree of ${id}${out.branchKept ? '; its branch was kept because it may hold work' : ' and its unused branch'}\n`);
    return 0;
  }
  if (sub === 'create') {
    let repo: string | undefined;
    let task: string | undefined;
    let confirm = false;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--confirm') confirm = true;
      else if ((a === '--repo' || a === '--task') && rest[i + 1] !== undefined && !(rest[i + 1] ?? '').startsWith('--')) {
        if (a === '--repo') repo = rest[i + 1];
        else task = rest[i + 1];
        i += 1;
      } else {
        io.error(`${WORKTREE_USAGE}\n`);
        return 2;
      }
    }
    if (repo === undefined) {
      io.error(`${WORKTREE_USAGE}\n`);
      return 2;
    }
    const plan = await planWorktree(resolve(repo), task ?? newTaskId(), dataDir, deps);
    if (!plan.ok) {
      io.error(`worktree: refused: ${WHY[plan.problem] ?? plan.problem}\n`);
      return 1;
    }
    io.out(`plan: new branch ${plan.branch} from ${plan.baseHead.slice(0, 12)}${plan.baseBranch === undefined ? '' : ` (${safeText(plan.baseBranch)})`}\n      folder ${safeText(plan.path)}\n      repository ${safeText(plan.repoRoot)} is not modified\n`);
    if (!confirm) {
      io.out('nothing was created; add --confirm to create it\n');
      return 0;
    }
    const made = await createWorktree(plan, dataDir, now(), deps);
    if (!made.ok) {
      io.error(`worktree: not created: ${WHY[made.problem] ?? made.problem}\n`);
      return 1;
    }
    io.out(`created. Use it with: orchestrate --workflow plan-implement-review --workspace "${safeText(plan.path)}" ...\n`);
    return 0;
  }
  io.error(`${WORKTREE_USAGE}\n`);
  return 2;
}
