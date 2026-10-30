import { sanitize } from './codex-run.ts';
import { collectChanges, readDiff, snapshotWorkspace, type GitReadDeps, type WorkspaceChanges, type WorkspaceSnapshot } from './git-state.ts';
import type { StepOutcome } from './orchestration.ts';
import { DEFAULT_LIMITS, checkWorkspaceChanges, checkWorkspaceStart, type ChangeLimits, type ChangeProblem, type StartProblem } from './workspace-policy.ts';

export type PrepareResult =
  | { readonly ok: true; readonly before: WorkspaceSnapshot }
  | { readonly ok: false; readonly reason: 'git-state-unreadable' }
  | { readonly ok: false; readonly reason: 'workspace-rejected'; readonly problems: readonly StartProblem[]; readonly snapshot: WorkspaceSnapshot };

/** Read-only check that the named directory is a clean, linked, non-protected worktree. */
export async function prepareWorkspace(cwd: string, deps: GitReadDeps = {}): Promise<PrepareResult> {
  const result = await snapshotWorkspace(cwd, deps);
  if (!result.ok) return { ok: false, reason: 'git-state-unreadable' };
  const problems = checkWorkspaceStart(result.snapshot);
  return problems.length === 0
    ? { ok: true, before: result.snapshot }
    : { ok: false, reason: 'workspace-rejected', problems, snapshot: result.snapshot };
}

/** Most of the diff that goes into the report; the rest is cut and marked. */
const MAX_REPORT_DIFF_CHARS = 10_000;

export function describeProblem(problem: ChangeProblem): string {
  return problem.detail === undefined ? problem.code : `${problem.code} (${problem.detail})`;
}

export function formatChangeReport(input: {
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  changes: WorkspaceChanges;
  problems: readonly ChangeProblem[];
  diff: { text: string; truncated: boolean } | undefined;
}): string {
  const { before, after, changes, problems, diff } = input;
  const added = changes.tracked.reduce((n, t) => n + (t.added ?? 0), 0);
  const deleted = changes.tracked.reduce((n, t) => n + (t.deleted ?? 0), 0);
  const lines = [
    `workspace: ${after.root}`,
    `branch: ${after.branch ?? 'detached'}  head: ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}  (no commit is made by this tool)`,
    `changes: ${String(changes.paths.length)} files, +${String(added)} -${String(deleted)} lines in tracked files, ${String(changes.untracked.length)} new files`,
    ...changes.tracked.map((t) => `  ${t.added === undefined ? 'binary' : `+${String(t.added)} -${String(t.deleted ?? 0)}`}  ${sanitize(t.path)}`),
    ...changes.untracked.map((u) => `  new  ${sanitize(u.path)} (${String(u.bytes)} bytes)`),
    problems.length === 0 ? 'policy: ok' : `policy: ${problems.map(describeProblem).join('; ')}`,
  ];
  if (diff !== undefined && diff.text !== '') {
    const cut = diff.text.length > MAX_REPORT_DIFF_CHARS;
    lines.push('--- diff of tracked files ---', cut ? diff.text.slice(0, MAX_REPORT_DIFF_CHARS) : diff.text.trimEnd());
    if (cut || diff.truncated) lines.push('[diff truncated]');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The step that runs after the implementation step (and after a failed or cancelled one): it
 * re-reads the workspace, enforces the limits, and reports the real state. It never reverts,
 * deletes, commits or pushes anything; a violation only fails the step and is reported.
 */
export function createWorkspaceInspector(options: {
  cwd: string;
  before: WorkspaceSnapshot;
  limits?: ChangeLimits;
  git?: GitReadDeps;
}): () => Promise<StepOutcome> {
  const deps = options.git ?? {};
  return async () => {
    const after = await snapshotWorkspace(options.cwd, deps);
    const changes = after.ok ? await collectChanges(after.snapshot.root, deps) : undefined;
    if (!after.ok || changes === undefined || !changes.ok) {
      return { kind: 'rejected', error: 'workspace state could not be read after the implementation step; inspect it manually with git status' };
    }
    const problems = checkWorkspaceChanges(options.before, after.snapshot, changes.changes, options.limits ?? DEFAULT_LIMITS);
    const diff = await readDiff(after.snapshot.root, deps);
    const output = formatChangeReport({ before: options.before, after: after.snapshot, changes: changes.changes, problems, diff });
    return problems.length === 0
      ? { kind: 'completed', output, truncated: diff?.truncated ?? false }
      : { kind: 'rejected', error: `workspace policy: ${problems.map((p) => p.code).join(', ')}`, output };
  };
}
