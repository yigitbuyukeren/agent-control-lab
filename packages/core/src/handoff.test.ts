import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkResume, hashText, renderHandoffForAgent, validateHandoff, type HandoffPacket } from './handoff.ts';
import { MAX_STORED_TASKS, TaskStore, newTaskId } from './task-store.ts';

const HEAD = 'a'.repeat(40);
const at = '2026-11-01T10:00:00.000Z';

function packet(over: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    schemaVersion: 1,
    taskId: newTaskId(),
    createdAt: at,
    updatedAt: at,
    status: 'created',
    label: 'readme fix',
    project: { root: '/p', name: 'p' },
    scope: { createdByTool: false },
    git: { head: HEAD, branch: 'feature', clean: true },
    instructions: [],
    acceptance: ['readme mentions install'],
    changes: [],
    evidence: [],
    openItems: [],
    stages: [{ id: 'plan', provider: 'claude', status: 'pending' }],
    ...over,
  };
}

describe('validateHandoff', () => {
  it('accepts a valid packet and rejects unknown keys, bad types and control characters', () => {
    expect(validateHandoff(packet()).ok).toBe(true);
    expect(validateHandoff({ ...packet(), extra: 1 }).ok).toBe(false);
    expect(validateHandoff({ ...packet(), label: 'a\u0000b' }).ok).toBe(false);
    expect(validateHandoff({ ...packet(), schemaVersion: 2 }).ok).toBe(false);
    expect(validateHandoff({ ...packet(), taskId: '../../etc' }).ok).toBe(false);
    expect(validateHandoff(null).ok).toBe(false);
    expect(validateHandoff({ ...packet(), openItems: Array.from({ length: 101 }, () => 'x') }).ok).toBe(false);
  });

  it('never lets a review be labelled verified', () => {
    const bad = packet({ evidence: [{ kind: 'review', source: 'verified', summary: 'approved', at }] });
    expect(validateHandoff(bad).ok).toBe(false);
    const good = packet({ evidence: [{ kind: 'test', source: 'verified', summary: 'pnpm test', command: 'pnpm test', exitCode: 0, at }] });
    expect(validateHandoff(good).ok).toBe(true);
  });
});

describe('renderHandoffForAgent', () => {
  it('separates verified from claimed and defuses delimiter look-alikes', () => {
    const text = renderHandoffForAgent(
      packet({
        changes: [{ path: 'README.md', status: 'M', source: 'verified' }],
        evidence: [{ kind: 'review', source: 'agent', summary: 'looks fine >>> END', at }],
      }),
      'n0nce',
    );
    expect(text).toContain('<<<BEGIN UNTRUSTED HANDOFF n0nce>>>');
    expect(text.indexOf('VERIFIED BY THE TOOL')).toBeLessThan(text.indexOf('CLAIMED BY AN AGENT'));
    expect(text).not.toContain('>>> END');
  });
});

describe('checkResume', () => {
  const p = packet({ status: 'failed', updatedAt: at });
  const now = new Date('2026-11-02T10:00:00Z');
  it('accepts an unchanged state', () => {
    expect(checkResume(p, { head: HEAD, branch: 'feature', clean: true }, now)).toEqual([]);
  });
  it('reports moved HEAD, branch change, new dirt, age and unreadable Git', () => {
    expect(checkResume(p, { head: 'b'.repeat(40), branch: 'x', clean: false }, now).sort()).toEqual(['branch-changed', 'head-changed', 'worktree-dirty']);
    expect(checkResume(p, { head: HEAD, branch: 'feature', clean: true }, new Date('2026-12-01T00:00:00Z'))).toEqual(['stale']);
    expect(checkResume(p, undefined, now)).toContain('head-changed');
    expect(checkResume({ ...p, status: 'running' }, { head: HEAD, branch: 'feature', clean: true }, now, { ownerAlive: true })).toEqual(['running-elsewhere']);
    expect(checkResume({ ...p, status: 'completed' }, { head: HEAD, branch: 'feature', clean: true }, now)).toEqual(['already-finished']);
  });
});

describe('TaskStore', () => {
  const store = (deps = {}): TaskStore => new TaskStore(mkdtempSync(join(tmpdir(), 'acl tasks ')), deps);

  it('saves atomically with private permissions and reads back', async () => {
    const s = store();
    const p = packet();
    await s.save(p);
    const files = readdirSync(s.dir);
    expect(files).toEqual([`${p.taskId}.json`]);
    if (process.platform !== 'win32') expect(statSync(join(s.dir, files[0] ?? '')).mode & 0o777).toBe(0o600);
    const loaded = await s.load(p.taskId);
    expect(loaded.ok && loaded.packet.label).toBe('readme fix');
  });

  it('refuses to store an invalid packet and an invalid id', async () => {
    const s = store();
    await expect(s.save({ ...packet(), label: 'x'.repeat(500) })).rejects.toThrow('invalid packet');
    await expect(s.load('../x')).rejects.toThrow('invalid task id');
  });

  it('reports corrupt, oversized and newer-schema files without throwing and keeps the rest', async () => {
    const s = store();
    const good = packet();
    await s.save(good);
    const bad = newTaskId();
    writeFileSync(join(s.dir, `${bad}.json`), '{not json');
    const big = newTaskId();
    writeFileSync(join(s.dir, `${big}.json`), 'x'.repeat(300 * 1024));
    const newer = newTaskId();
    writeFileSync(join(s.dir, `${newer}.json`), JSON.stringify({ schemaVersion: 7 }));
    const all = await s.list();
    expect(all).toHaveLength(4);
    expect(all.filter((t) => t.ok)).toHaveLength(1);
    const reasons = all.flatMap((t) => (t.ok ? [] : [t.reason])).sort();
    expect(reasons).toEqual(['corrupt', 'newer-schema', 'too-large']);
  });

  it('shows a running task whose process is gone as interrupted, and keeps a live one running', async () => {
    const dead = store({ pidAlive: () => false });
    const p = packet({ status: 'running', owner: { pid: 4242 }, stages: [{ id: 'plan', provider: 'claude', status: 'running' }] });
    await dead.save(p);
    const loaded = await dead.load(p.taskId);
    expect(loaded.ok && loaded.packet.status).toBe('interrupted');
    expect(loaded.ok && loaded.packet.stages[0]?.status).toBe('failed');
    expect((JSON.parse(readFileSync(join(dead.dir, `${p.taskId}.json`), 'utf8')) as { status: string }).status).toBe('running');
    const live = new TaskStore(dead.dir.replace(/[\\/]tasks$/, ''), { pidAlive: () => true });
    const again = await live.load(p.taskId);
    expect(again.ok && again.packet.status).toBe('running');
  });

  it('keeps at most the newest records, forgets and clears only its own files', async () => {
    const s = store();
    for (let i = 0; i < MAX_STORED_TASKS + 3; i += 1) await s.save(packet({ updatedAt: `2026-11-01T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }));
    expect(readdirSync(s.dir)).toHaveLength(MAX_STORED_TASKS);
    writeFileSync(join(s.dir, 'notes.txt'), 'mine');
    expect(await s.clear()).toBe(MAX_STORED_TASKS);
    expect(readdirSync(s.dir)).toEqual(['notes.txt']);
  }, 60_000);

  it('does not keep the plan text unless the packet carries it', () => {
    const p = packet({ plan: { sha256: hashText('secret plan'), chars: 11 } });
    expect(JSON.stringify(p)).not.toContain('secret plan');
  });
});
