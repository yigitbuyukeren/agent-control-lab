import { groupOutcomes, type ClaudeRefusalReason, type MeasureKey, type OutcomeRecord, type Pinned, type RefusalReason, type SelectionIssue } from '@agent-control-lab/core';

export function describePinned(pinned: Pinned): string {
  if (pinned.kind === 'provider-default') return 'provider-default';
  return `${pinned.value} (${pinned.verified ? 'verified' : 'unverified'})`;
}

export function describeIssue(issue: SelectionIssue): string {
  const flag = issue.blocking ? 'blocking' : 'unverified';
  switch (issue.code) {
    case 'model-not-listed':
      return `model-not-listed [${flag}] ${issue.model}`;
    case 'model-discovery-failed':
      return `model-discovery-failed [${flag}] ${issue.model} (${issue.reason}${issue.error === undefined ? '' : `: ${issue.error}`})`;
    case 'model-access-unverified':
      return `model-access-unverified [${flag}] ${issue.model} (${issue.documented ? 'documented' : 'not documented'})`;
    case 'effort-invalid':
      return `effort-invalid [${flag}] ${issue.effort}`;
    case 'effort-unsupported':
      return `effort-unsupported [${flag}] ${issue.effort} (supported: ${issue.supported.join(', ')})`;
    case 'effort-unverified':
      return `effort-unverified [${flag}] ${issue.effort} (${issue.reason})`;
    case 'mode-unsupported':
      return `mode-unsupported [${flag}] ${issue.mode}`;
    case 'mode-effort-conflict':
      return `mode-effort-conflict [${flag}] ${issue.mode} cannot be combined with --effort ${issue.effort}`;
    case 'mode-unverified':
      return `mode-unverified [${flag}] ${issue.mode}`;
  }
}

export const REFUSALS: Record<RefusalReason, string> = {
  'not-a-git-repo':
    'the working directory is not inside a Git repository, which Codex needs. Run `git init` yourself or choose another --cwd (nothing is initialised automatically)',
  'git-not-installed': 'git is not installed, so the repository check could not run',
  'git-check-failed': 'the Git repository check failed or timed out',
  'unverified-selection': 'the model/effort selection could not be verified; add --accept-unverified to run anyway',
  'task-invalid': 'the task text is empty, too long or invalid',
  'codex-not-installed': 'codex is not installed',
  'not-logged-in': 'codex is not logged in',
  'login-state-unknown': 'codex login state could not be determined',
  'api-key-login': 'codex is logged in with an API key; only a subscription login is allowed',
  'login-method-unknown': 'codex login method is not a verified subscription login',
  'selection-blocked': 'the model/effort selection is blocked',
};


export const CLAUDE_REFUSALS: Record<ClaudeRefusalReason, string> = {
  'task-invalid': 'the task text is empty, too long or invalid',
  'claude-not-installed': 'claude is not installed',
  'not-logged-in': 'claude is not logged in',
  'login-state-unknown': 'claude login state could not be determined',
  'api-key-login': 'claude is using an API key; only a Pro/Max subscription login is allowed',
  'third-party-provider': 'claude is using a third-party provider; only a Pro/Max subscription login is allowed',
  'not-a-subscription-plan': 'claude is not signed in with a verified Pro/Max subscription',
  'claude-version-unsupported': 'this Claude Code version is older than the verified minimum for ultracode',
  'claude-version-unknown': 'the Claude Code version could not be read or parsed, which ultracode requires',
  'claude-flags-unverified': 'the Claude CLI did not list every safety flag the run needs (see claude --help); refusing to guess',
  'settings-unsafe': 'a Claude settings file sets credentials, a provider, a proxy or a login helper',
  'settings-unverifiable': 'a Claude settings file exists but could not be read or parsed, or the repository layout could not be established, so settings could not be verified',
  'network-env-not-forwarded':
    'proxy/TLS/base-URL variables are set in this shell but are not forwarded to Claude, which connects directly; add --accept-unverified to run without them',
  'selection-blocked': 'the model/effort/mode selection is blocked',
  'unverified-selection': 'the model/effort/mode selection could not be verified; add --accept-unverified to run anyway',
};

/** Summary of the local outcome records: counts only, grouped as the router compares them. */
export function formatOutcomes(records: readonly OutcomeRecord[], now: Date): string {
  if (records.length === 0) return 'outcomes: no local records (they are written by real orchestrate runs; --no-record skips)\n';
  const keys = new Map<string, MeasureKey>();
  for (const r of records) keys.set(`${r.provider}|${r.step}|${r.task}|${r.size}`, { provider: r.provider, step: r.step, task: r.task, size: r.size });
  let text = `outcomes: ${String(records.length)} local record(s); only a local check (verification command, workspace inspection) counts as pass or fail\n`;
  for (const key of [...keys.values()].sort((a, b) => `${a.provider}${a.step}${a.task}${a.size}`.localeCompare(`${b.provider}${b.step}${b.task}${b.size}`))) {
    text += `  ${key.provider} ${key.step}, ${key.task} task, ${key.size}:\n`;
    for (const g of groupOutcomes(records, key, now)) {
      text += `    ${g.model} / ${g.effort}: ${String(g.counts.pass)} pass, ${String(g.counts.fail)} fail, ${String(g.counts.error + g.counts.timeout)} error/timeout, ${String(g.counts.unmeasured)} unmeasured, median ${String(g.medianSeconds)}s${g.eligible ? '' : ' (too few to count)'}\n`;
    }
  }
  return text;
}
