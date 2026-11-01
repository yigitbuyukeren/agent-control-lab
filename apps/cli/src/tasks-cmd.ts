import { checkResume, isTaskId, snapshotWorkspace, type LoadedTask, type TaskStore } from '@agent-control-lab/core';
import { safeText } from './workspaces.ts';

export const TASKS_USAGE = 'usage: agent-control-lab tasks [list] | show <id> | resume-check <id> | forget <id> | clear';

interface Io {
  out(t: string): void;
  error(t: string): void;
}

function line(t: LoadedTask): string {
  if (!t.ok) return `${t.id}  unreadable (${t.reason}); not used\n`;
  const p = t.packet;
  return `${p.taskId}  ${p.status}${t.ownerGone ? ' (its process is gone)' : ''}  ${p.updatedAt}  ${safeText(p.label)}  ${safeText(p.project.name)}\n`;
}

/** Task history commands. Only the tool's own history files are read, listed or deleted. */
export async function runTasksCommand(argv: readonly string[], io: Io, store: TaskStore | undefined, now: () => Date = () => new Date()): Promise<number> {
  if (store === undefined) {
    io.error('tasks: no local store is available\n');
    return 1;
  }
  const [sub = 'list', id, ...rest] = argv;
  if (rest.length > 0) {
    io.error(`${TASKS_USAGE}\n`);
    return 2;
  }
  if (sub === 'list' && id === undefined) {
    const all = await store.list();
    io.out(all.length === 0 ? 'no recorded tasks\n' : all.map(line).join(''));
    return 0;
  }
  if (sub === 'clear' && id === undefined) {
    io.out(`tasks: ${String(await store.clear())} record(s) deleted\n`);
    return 0;
  }
  if ((sub === 'show' || sub === 'resume-check' || sub === 'forget') && id !== undefined && isTaskId(id)) {
    if (sub === 'forget') {
      await store.forget(id);
      io.out(`tasks: ${id} deleted\n`);
      return 0;
    }
    const loaded = await store.load(id);
    if (!loaded.ok) {
      io.error(`tasks: ${id} is ${loaded.reason}; it was not used\n`);
      return 1;
    }
    const p = loaded.packet;
    if (sub === 'show') {
      io.out(`${JSON.stringify(p, null, 2)}\n`);
      return 0;
    }
    // Resume never trusts the stored state: Git is read again now.
    const snap = await snapshotWorkspace(p.project.root);
    const problems = checkResume(p, snap.ok ? { head: snap.snapshot.head, branch: snap.snapshot.branch, clean: snap.snapshot.dirty.length === 0 } : undefined, now(), { ownerAlive: p.status === 'running' && !loaded.ownerGone });
    io.out(problems.length === 0 ? `${id}: state matches the record; safe to continue from "${p.nextStage ?? 'the next stage'}"\n` : `${id}: do not continue blindly: ${problems.join(', ')}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  io.error(`${TASKS_USAGE}\n`);
  return 2;
}
