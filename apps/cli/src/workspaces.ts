import { discoverWorkspaces, selectWorkspace, suggestWorkspace, type Discovery, type ScoredCandidate, type Suggestion, type WorkspaceCandidate } from '@agent-control-lab/core';
import { resolve } from 'node:path';

export interface WorkspacesArgs {
  readonly root: string;
  readonly task?: string;
  readonly select?: string;
  readonly json: boolean;
}

export const WORKSPACES_USAGE = 'usage: agent-control-lab workspaces --root <dir> [--task "<text>"] [--select <relative path | name>] [--json]';

export function parseWorkspacesArgs(args: readonly string[]): WorkspacesArgs | string {
  let root: string | undefined;
  let task: string | undefined;
  let select: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--root' || arg === '--task' || arg === '--select') {
      const value = args[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return `${arg} needs a value\n${WORKSPACES_USAGE}`;
      i += 1;
      if (arg === '--root') root = value;
      else if (arg === '--task') task = value;
      else select = value;
    } else return `unknown option: ${String(arg)}\n${WORKSPACES_USAGE}`;
  }
  if (root === undefined) return `--root is required\n${WORKSPACES_USAGE}`;
  if (task !== undefined && select !== undefined) return `use either --task (suggest) or --select (choose), not both\n${WORKSPACES_USAGE}`;
  return { root: resolve(root), ...(task === undefined ? {} : { task }), ...(select === undefined ? {} : { select }), json };
}

/** A path or name shown to the user, with control characters removed. */
export const safeText = (text: string): string => Array.from(text, (ch) => (ch < ' ' || ch === '\u007f' ? '?' : ch)).join('');

function describe(c: WorkspaceCandidate): string {
  const tags = [c.kind, ...(c.monorepo ? ['monorepo'] : []), ...(c.nestedIn === undefined ? [] : ['nested repo'])];
  const extra = [...(c.packageName !== undefined && c.packageName !== c.name ? [`package ${safeText(c.packageName)}`] : []), ...(c.markers.length > 0 ? [`markers: ${c.markers.join(', ')}`] : [])];
  return `${safeText(c.relative)}  [${tags.join(', ')}]${extra.length > 0 ? `  ${extra.join('; ')}` : ''}`;
}

function scored(s: ScoredCandidate): string {
  return `  ${safeText(s.candidate.relative)} (score ${String(s.score)}): ${s.reasons.join('; ')}\n`;
}

export function formatDiscovery(found: Discovery): string {
  let out = `root: ${safeText(found.root)}\n`;
  if (found.enclosingRepo !== undefined) out += `inside Git repository: ${safeText(found.enclosingRepo)}\n`;
  out += `candidates: ${String(found.candidates.length)}${found.truncated ? ' (list truncated by limits)' : ''}\n`;
  for (const c of found.candidates) out += `  ${describe(c)}\n`;
  if (found.skipped.length > 0) {
    out += `not entered: ${String(found.skipped.length)}\n`;
    for (const s of found.skipped.slice(0, 20)) out += `  ${safeText(s.relative)}: ${s.reason}\n`;
  }
  return out;
}

export function formatSuggestion(s: Suggestion): string {
  if (s.state === 'none') return 'suggestion: none (no candidate matches the task); choose one with --select\n';
  if (s.state === 'ambiguous') {
    return `suggestion: ambiguous, nothing was chosen. These match about equally; choose one with --select:\n${s.matches.map(scored).join('')}`;
  }
  return `suggestion (not applied; confirm with --select ${safeText(s.best.candidate.relative)}):\n${scored(s.best)}${s.others.length > 0 ? `other matches:\n${s.others.slice(0, 5).map(scored).join('')}` : ''}`;
}

export async function runWorkspacesCommand(args: WorkspacesArgs, io: { out(text: string): void; error(text: string): void }): Promise<number> {
  const found = await discoverWorkspaces(args.root);
  if ('error' in found) {
    io.error(`${found.error}\n`);
    return 1;
  }
  const chosen = args.select === undefined ? undefined : selectWorkspace(found.candidates, args.select);
  const suggestion = args.task === undefined ? undefined : suggestWorkspace(args.task, found.candidates);
  if (args.json) {
    io.out(`${JSON.stringify({ ...found, ...(suggestion === undefined ? {} : { suggestion }), ...(chosen === undefined ? {} : { selected: chosen.ok ? { path: chosen.candidate.path, relative: chosen.candidate.relative, reason: 'chosen manually' } : { error: chosen.error } }) }, null, 2)}\n`);
    return chosen !== undefined && !chosen.ok ? 1 : 0;
  }
  io.out(formatDiscovery(found));
  if (suggestion !== undefined) io.out(formatSuggestion(suggestion));
  if (chosen !== undefined) {
    if (!chosen.ok) {
      io.error(`${chosen.error}\n`);
      return 1;
    }
    io.out(`selected: ${safeText(chosen.candidate.path)} (chosen manually)\n`);
  }
  return 0;
}
