import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTaskId, validateHandoff, type HandoffPacket } from './handoff.ts';

export const MAX_TASK_FILE_BYTES = 256 * 1024;
export const MAX_STORED_TASKS = 200;

export interface TaskStoreDeps {
  readonly now?: () => Date;
  readonly pidAlive?: (pid: number) => boolean;
}

export type LoadedTask =
  | { readonly ok: true; readonly packet: HandoffPacket; readonly ownerGone: boolean }
  | { readonly ok: false; readonly id: string; readonly reason: 'corrupt' | 'too-large' | 'unreadable' | 'newer-schema' };

export function newTaskId(): string {
  return `t-${randomBytes(6).toString('hex')}`;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Local task history. One small JSON file per task, written to a temporary file and renamed, readable by the
 * user only, bounded in size and count. Prompts, model output and file contents are not part of a packet.
 */
export class TaskStore {
  readonly dir: string;
  private readonly deps: TaskStoreDeps;

  constructor(cacheDir: string, deps: TaskStoreDeps = {}) {
    this.dir = join(cacheDir, 'tasks');
    this.deps = deps;
  }

  private file(id: string): string {
    if (!isTaskId(id)) throw new Error('invalid task id');
    return join(this.dir, `${id}.json`);
  }

  async save(packet: HandoffPacket): Promise<void> {
    const checked = validateHandoff(packet);
    if (!checked.ok) throw new Error(`refusing to store an invalid packet: ${checked.errors[0] ?? ''}`);
    const body = `${JSON.stringify(packet, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_TASK_FILE_BYTES) throw new Error('task record too large');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(packet.taskId);
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, target);
      await chmod(target, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    await this.prune();
  }

  async load(id: string): Promise<LoadedTask> {
    const path = this.file(id);
    try {
      const info = await stat(path);
      if (info.size > MAX_TASK_FILE_BYTES) return { ok: false, id, reason: 'too-large' };
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 && typeof (parsed as { schemaVersion?: unknown }).schemaVersion === 'number') {
        return { ok: false, id, reason: 'newer-schema' };
      }
      const checked = validateHandoff(parsed);
      if (!checked.ok) return { ok: false, id, reason: 'corrupt' };
      return { ok: true, packet: this.withDerivedStatus(checked.packet), ownerGone: this.ownerGone(checked.packet) };
    } catch (error) {
      return { ok: false, id, reason: error instanceof SyntaxError ? 'corrupt' : 'unreadable' };
    }
  }

  private ownerGone(packet: HandoffPacket): boolean {
    return packet.status === 'running' && packet.owner !== undefined && !(this.deps.pidAlive ?? defaultPidAlive)(packet.owner.pid);
  }

  /** A task recorded as running whose owner process is gone is reported as interrupted (the file is not rewritten). */
  private withDerivedStatus(packet: HandoffPacket): HandoffPacket {
    return this.ownerGone(packet) ? { ...packet, status: 'interrupted', stages: packet.stages.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s)) } : packet;
  }

  async list(): Promise<LoadedTask[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const ids = names.filter((n) => n.endsWith('.json') && isTaskId(n.slice(0, -5))).map((n) => n.slice(0, -5));
    const tasks = await Promise.all(ids.map((id) => this.load(id)));
    return tasks.sort((a, b) => (a.ok && b.ok ? b.packet.updatedAt.localeCompare(a.packet.updatedAt) : a.ok ? -1 : b.ok ? 1 : 0));
  }

  async forget(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  async clear(): Promise<number> {
    let count = 0;
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const n of names) {
      if (n.endsWith('.json') && isTaskId(n.slice(0, -5)) && (await rm(join(this.dir, n), { force: true }).then(() => true, () => false))) count += 1;
    }
    return count;
  }

  /** Keeps the newest records; only this store's own task files are ever removed. */
  private async prune(): Promise<void> {
    const all = await this.list();
    const surplus = all.slice(MAX_STORED_TASKS);
    for (const t of surplus) await this.forget(t.ok ? t.packet.taskId : t.id);
  }
}
