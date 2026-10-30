import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitize } from './codex-run.ts';
import {
  collectChanges,
  readDiff,
  snapshotWorkspace,
  type GitReadDeps,
  type UntrackedFile,
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from './git-state.ts';
import { MAX_HANDOFF_CHARS, type StepOutcome } from './orchestration.ts';
import {
  DEFAULT_LIMITS,
  checkAfterVerification,
  checkWorkspaceChanges,
  checkWorkspaceStart,
  isVerifyHarnessPath,
  type ChangeLimits,
  type ChangeProblem,
  type StartOptions,
  type StartProblem,
} from './workspace-policy.ts';

export type PrepareResult =
  | { readonly ok: true; readonly before: WorkspaceSnapshot }
  | { readonly ok: false; readonly reason: 'git-state-unreadable' }
  | { readonly ok: false; readonly reason: 'workspace-rejected'; readonly problems: readonly StartProblem[]; readonly snapshot: WorkspaceSnapshot };

/** Read-only check that the named directory is a clean, linked, non-protected worktree. */
export async function prepareWorkspace(cwd: string, deps: GitReadDeps = {}, options: StartOptions = {}): Promise<PrepareResult> {
  const result = await snapshotWorkspace(cwd, deps);
  if (!result.ok) return { ok: false, reason: 'git-state-unreadable' };
  const problems = checkWorkspaceStart(result.snapshot, options);
  return problems.length === 0
    ? { ok: true, before: result.snapshot }
    : { ok: false, reason: 'workspace-rejected', problems, snapshot: result.snapshot };
}

/**
 * Characters of diff (tracked and new files together) that go into the report and so into the
 * review. A change that does not fit completely is never reviewed in part: it is rejected as
 * `review-incomplete` and no approval can come out of it.
 */
export const REVIEW_DIFF_CHARS = 12_000;

export function describeProblem(problem: ChangeProblem): string {
  return problem.detail === undefined ? problem.code : `${problem.code} (${problem.detail})`;
}

/** Why the review input does not show the whole change; empty means it does. */
export type IncompleteReason =
  | 'tracked-diff-unreadable'
  | 'tracked-diff-truncated'
  | 'new-file-unreadable'
  | 'new-file-not-text'
  | 'new-file-truncated'
  | 'report-too-long';

const TEXT = new TextDecoder('utf-8', { fatal: true });

/** A `git diff`-style block for one new text file, so the reviewer sees what it contains. */
export async function newFileDiff(root: string, file: UntrackedFile): Promise<{ text: string } | { reason: IncompleteReason }> {
  const path = join(root, file.path);
  let content: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { reason: 'new-file-unreadable' };
    const bytes = await readFile(path);
    if (bytes.includes(0)) return { reason: 'new-file-not-text' };
    content = TEXT.decode(bytes);
  } catch (cause) {
    return { reason: cause instanceof TypeError ? 'new-file-not-text' : 'new-file-unreadable' };
  }
  const lines = sanitize(content.replaceAll('\r\n', '\n')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const name = sanitize(file.path);
  const body = lines.map((line) => `+${line}`).join('\n');
  return { text: `diff --git a/${name} b/${name}\nnew file\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${String(lines.length)} @@\n${body}\n` };
}

export interface ReviewMaterial {
  /** Tracked diff followed by the new files, within `REVIEW_DIFF_CHARS`. */
  readonly diff: string;
  readonly incomplete: readonly IncompleteReason[];
}

/** Builds the diff the reviewer sees and records every way it falls short of the whole change. */
export async function buildReviewMaterial(
  root: string,
  changes: WorkspaceChanges,
  tracked: { text: string; truncated: boolean } | undefined,
): Promise<ReviewMaterial> {
  const incomplete = new Set<IncompleteReason>();
  let diff = '';
  if (changes.tracked.length > 0) {
    if (tracked === undefined) incomplete.add('tracked-diff-unreadable');
    else {
      if (tracked.truncated) incomplete.add('tracked-diff-truncated');
      diff = tracked.text.endsWith('\n') || tracked.text === '' ? tracked.text : `${tracked.text}\n`;
    }
  }
  const trackedLength = diff.length;
  for (const file of changes.untracked) {
    const block = await newFileDiff(root, file);
    if ('reason' in block) incomplete.add(block.reason);
    else diff += block.text;
  }
  if (diff.length > REVIEW_DIFF_CHARS) {
    incomplete.add(trackedLength > REVIEW_DIFF_CHARS ? 'tracked-diff-truncated' : 'new-file-truncated');
    diff = diff.slice(0, REVIEW_DIFF_CHARS);
  }
  return { diff, incomplete: [...incomplete] };
}

export function formatChangeReport(input: {
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  changes: WorkspaceChanges;
  problems: readonly ChangeProblem[];
  material: ReviewMaterial;
}): string {
  const { before, after, changes, problems, material } = input;
  const added = changes.tracked.reduce((n, t) => n + (t.added ?? 0), 0);
  const deleted = changes.tracked.reduce((n, t) => n + (t.deleted ?? 0), 0);
  const lines = [
    `workspace: ${after.root}`,
    `branch: ${after.branch ?? 'detached'}  head: ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}  (no commit is made by this tool)`,
    `changes: ${String(changes.paths.length)} files, +${String(added)} -${String(deleted)} lines in tracked files, ${String(changes.untracked.length)} new files`,
    ...changes.tracked.map((t) => `  ${t.added === undefined ? 'binary' : `+${String(t.added)} -${String(t.deleted ?? 0)}`}  ${sanitize(t.path)}`),
    ...changes.untracked.map((u) => `  new  ${sanitize(u.path)} (${String(u.bytes)} bytes)`),
    after.ignoredPartial.length === 0
      ? 'ignored files: compared in full'
      : `ignored files: PARTIAL (compared one level deep only: ${after.ignoredPartial.map(sanitize).join(', ')})`,
    problems.length === 0 ? 'policy: ok' : `policy: ${problems.map(describeProblem).join('; ')}`,
    material.incomplete.length === 0
      ? 'review input: complete (every changed line below is shown in full)'
      : `review input: INCOMPLETE (${material.incomplete.join(', ')}); no approval can be based on it`,
  ];
  if (material.diff !== '') lines.push('--- diff (tracked files, then new files) ---', material.diff.trimEnd());
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
    const root = after.snapshot.root;
    const tracked = await readDiff(root, deps);
    const material = await buildReviewMaterial(root, changes.changes, tracked);
    const all: ChangeProblem[] = [...problems];
    let output = formatChangeReport({ before: options.before, after: after.snapshot, changes: changes.changes, problems, material });
    const incomplete: IncompleteReason[] = [...material.incomplete];
    if (output.length > MAX_HANDOFF_CHARS) incomplete.push('report-too-long');
    if (incomplete.length > 0) {
      all.push({ code: 'review-incomplete', detail: incomplete.join(', ') });
      output = formatChangeReport({ before: options.before, after: after.snapshot, changes: changes.changes, problems: all, material: { diff: material.diff, incomplete } });
    }
    return all.length === 0
      ? { kind: 'completed', output, truncated: false }
      : { kind: 'rejected', error: `workspace policy: ${all.map((p) => p.code).join(', ')}`, output: output.slice(0, MAX_HANDOFF_CHARS) };
  };
}

export interface VerificationGuard {
  /** Refuses (as a rejected outcome) when verification would run harness files the step changed. */
  readonly gate: () => Promise<StepOutcome | undefined>;
  /** Fails when verification itself moved history, wrote into the main worktree or rewrote tracked files. */
  readonly after: (verifyOutcome: StepOutcome) => Promise<StepOutcome>;
}

/**
 * Guards the opt-in verification. Verification runs newly written code outside any model sandbox,
 * so before it the changed paths are checked for files that decide what the test command runs, and
 * afterwards the workspace and the main worktree are compared again. This reduces the risk; it
 * is not a sandbox.
 */
export function createVerificationGuard(options: { cwd: string; git?: GitReadDeps }): VerificationGuard {
  const deps = options.git ?? {};
  let base: { snapshot: WorkspaceSnapshot; changes: WorkspaceChanges } | undefined;
  return {
    gate: async () => {
      const snapshot = await snapshotWorkspace(options.cwd, deps);
      const changes = snapshot.ok ? await collectChanges(snapshot.snapshot.root, deps) : undefined;
      if (!snapshot.ok || changes === undefined || !changes.ok) {
        return { kind: 'rejected', error: 'verification refused: the workspace state could not be read' };
      }
      const harness = changes.changes.paths.filter(isVerifyHarnessPath);
      if (harness.length > 0) {
        return {
          kind: 'rejected',
          error: 'verification refused: changed files can alter what the test command runs',
          output: `files that define how tests or builds run were changed: ${harness.slice(0, 5).map(sanitize).join(', ')}\nrun the tests yourself after reading the diff\n`,
        };
      }
      base = { snapshot: snapshot.snapshot, changes: changes.changes };
      return undefined;
    },
    after: async (verifyOutcome) => {
      const snapshot = await snapshotWorkspace(options.cwd, deps);
      const changes = snapshot.ok ? await collectChanges(snapshot.snapshot.root, deps) : undefined;
      const report = verifyOutcome.kind === 'completed' || verifyOutcome.kind === 'rejected' ? (verifyOutcome.output ?? '') : '';
      if (base === undefined || !snapshot.ok || changes === undefined || !changes.ok) {
        return { kind: 'rejected', error: 'workspace state could not be read after verification; inspect it manually with git status', output: report };
      }
      const problems = checkAfterVerification(base.snapshot, snapshot.snapshot, base.changes, changes.changes);
      if (problems.length > 0) {
        return {
          kind: 'rejected',
          error: `workspace policy after verification: ${problems.map((p) => p.code).join(', ')}`,
          output: `${report}verification changed more than test output: ${problems.map(describeProblem).join('; ')}\n`,
        };
      }
      return verifyOutcome;
    },
  };
}
