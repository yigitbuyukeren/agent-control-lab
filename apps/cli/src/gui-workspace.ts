import { collectChanges, digestSigs, snapshotWorkspace, type WorkspaceSnapshot } from '@agent-control-lab/core';
import { maskSecrets } from './gui-secrets.ts';

const MAX_FILES = 200;

/** What the page shows about a workspace after a real write run: read from Git, never taken from model text. */
export interface WorkspaceReport {
  readonly readable: boolean;
  readonly root?: string;
  readonly branch?: string;
  readonly headBefore?: string;
  readonly headAfter?: string;
  /** HEAD or any local branch moved: something committed, which this tool never does. */
  readonly committed: boolean;
  readonly files: readonly { path: string; kind: 'changed' | 'new'; added?: number; deleted?: number; bytes?: number }[];
  readonly truncated: boolean;
  readonly added: number;
  readonly deleted: number;
}

/** A workspace read taken before the preview is trusted and before a run starts. */
export interface WorkspaceState {
  /** Changes whenever the head, a branch, a dirty path or an ignored file changed. */
  readonly fingerprint: string;
  readonly root: string;
  readonly head: string;
  readonly branch: string | undefined;
  readonly refs: string;
}

export interface WorkspaceProbe {
  /** `undefined` when the state cannot be read: the caller then refuses. */
  read(path: string): Promise<WorkspaceState | undefined>;
  report(path: string, before: WorkspaceState | undefined): Promise<WorkspaceReport>;
}

export function stateOf(s: WorkspaceSnapshot): WorkspaceState {
  const refs = digestSigs(s.refs);
  return {
    root: s.root,
    head: s.head,
    branch: s.branch,
    refs,
    fingerprint: digestSigs({
      head: s.head,
      branch: s.branch ?? '',
      refs,
      dirty: s.dirty.join('\0'),
      ignored: digestSigs(s.ignored),
      dirtySigs: digestSigs(s.dirtySigs),
      mainDirty: digestSigs(s.mainDirty),
    }),
  };
}

/** The real probe: the same read-only Git calls the CLI's own workspace checks use. */
export function gitWorkspaceProbe(): WorkspaceProbe {
  return {
    async read(path) {
      const snap = await snapshotWorkspace(path);
      return snap.ok ? stateOf(snap.snapshot) : undefined;
    },
    async report(path, before) {
      const snap = await snapshotWorkspace(path);
      const changes = snap.ok ? await collectChanges(snap.snapshot.root) : undefined;
      if (!snap.ok || changes === undefined || !changes.ok) return { readable: false, committed: false, files: [], truncated: false, added: 0, deleted: 0 };
      const after = stateOf(snap.snapshot);
      const files = [
        ...changes.changes.tracked.map((t) => ({ path: maskSecrets(t.path, []), kind: 'changed' as const, ...(t.added === undefined ? {} : { added: t.added }), ...(t.deleted === undefined ? {} : { deleted: t.deleted }) })),
        ...changes.changes.untracked.map((u) => ({ path: maskSecrets(u.path, []), kind: 'new' as const, bytes: u.bytes })),
      ];
      return {
        readable: true,
        root: after.root,
        ...(after.branch === undefined ? {} : { branch: after.branch }),
        ...(before === undefined ? {} : { headBefore: before.head }),
        headAfter: after.head,
        committed: before !== undefined && (before.head !== after.head || before.refs !== after.refs),
        files: files.slice(0, MAX_FILES),
        truncated: files.length > MAX_FILES,
        added: changes.changes.tracked.reduce((n, t) => n + (t.added ?? 0), 0),
        deleted: changes.changes.tracked.reduce((n, t) => n + (t.deleted ?? 0), 0),
      };
    },
  };
}
