import {
  collectChanges,
  hashText,
  newTaskId,
  snapshotWorkspace,
  type GitReadDeps,
  type HandoffEvidence,
  type HandoffPacket,
  type TaskStore,
  type WorkflowResult,
} from '@agent-control-lab/core';
import { basename } from 'node:path';

/**
 * Stores a short, privacy-preserving record of a finished run: no prompt, no model output, no plan text.
 * Git facts and the local inspection/test steps are marked `verified`; model statements are marked `agent`.
 * Never throws: a store problem is one line and the run result is unaffected.
 */
export async function recordTask(
  store: TaskStore | undefined,
  enabled: boolean,
  input: { workflow: string; cwd: string; result: WorkflowResult; planText?: string; git?: GitReadDeps; now: Date; pid?: number },
): Promise<string> {
  if (store === undefined) return '';
  if (!enabled) return 'task history: not recorded (--no-record)\n';
  try {
    const at = input.now.toISOString();
    const snap = await snapshotWorkspace(input.cwd, input.git);
    const changes = snap.ok ? await collectChanges(snap.snapshot.root, input.git) : ({ ok: false } as const);
    const status = input.result.status === 'completed' ? 'completed' : input.result.status === 'cancelled' ? 'cancelled' : input.result.steps.some((s) => s.status === 'timeout') ? 'timeout' : 'failed';
    const stages = input.result.steps.flatMap((s) => (s.provider === 'local' ? [] : [{ id: s.id, provider: s.provider, status: s.status, endedAt: at }]));
    const packet: HandoffPacket = {
      schemaVersion: 1,
      taskId: newTaskId(),
      createdAt: at,
      updatedAt: at,
      status,
      label: input.workflow,
      project: { root: input.cwd, name: basename(input.cwd) },
      scope: { ...(snap.ok ? { repoRoot: snap.snapshot.root } : {}), createdByTool: false },
      git: snap.ok ? { head: snap.snapshot.head, ...(snap.snapshot.branch === undefined ? {} : { branch: snap.snapshot.branch }), clean: snap.snapshot.dirty.length === 0 } : { head: '0'.repeat(40), clean: false },
      instructions: [],
      ...(input.planText === undefined ? {} : { plan: { sha256: hashText(input.planText), chars: input.planText.length } }),
      acceptance: [],
      changes: changes.ok ? changes.changes.paths.slice(0, 500).map((path) => ({ path, status: 'changed', source: 'verified' as const })) : [],
      evidence: [
        ...(changes.ok ? [{ kind: 'git-change' as const, source: 'verified' as const, summary: `${String(changes.changes.paths.length)} path(s) changed according to Git`, at }] : []),
        ...input.result.steps.flatMap<HandoffEvidence>((s) =>
          s.id === 'verify' && (s.status === 'completed' || s.status === 'failed')
            ? [{ kind: 'test' as const, source: 'verified' as const, summary: s.status === 'completed' ? 'verification command passed' : 'verification command failed', at }]
            : s.id === 'review' && s.status === 'completed'
              ? [{ kind: 'review' as const, source: 'agent' as const, summary: 'review step completed; its verdict is model text and was not verified', at }]
              : [],
        ),
      ],
      openItems: status === 'completed' ? [] : [`run ended as ${status}; check the workspace before continuing`],
      stages,
    };
    await store.save(packet);
    return `task history: recorded ${packet.taskId} (no prompt, output or plan text; \`tasks\` lists, \`tasks clear\` deletes, --no-record skips)\n`;
  } catch {
    return 'task history: could not be recorded locally\n';
  }
}
