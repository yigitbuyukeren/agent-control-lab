import {
  selectionSteps,
  type SelectionProvider,
  type SelectionStep,
  type Selection,
  type StepRequest,
  type StepRequests,
  type WorkflowName,
} from '@agent-control-lab/core';
import { CLAUDE_REFUSALS, REFUSALS, describeIssue, describePinned } from './format.ts';
import { claudePreflight, codexPreflight, type ClaudePreflight, type CodexPreflight, type PreflightDeps } from './preflight.ts';

/** Why Claude's preflight refused, without values: variable and settings key names only. */
export function claudeDetails(pf: ClaudePreflight): string {
  const plan = pf.plan;
  if (plan.ok) return '';
  const lines = [
    ...plan.findings.map((f) => `      finding: ${f.kind} settings ${f.key}\n`),
    ...plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`),
  ];
  if (pf.settings.status === 'unverifiable') {
    lines.push(
      pf.settings.problem === 'repo-unresolved'
        ? '      settings: repository root could not be resolved\n'
        : `      settings: ${pf.settings.kind} file is ${pf.settings.problem}\n`,
    );
  }
  if (plan.reason === 'network-env-not-forwarded') lines.push(`      not forwarded: ${pf.networkRedirects.join(', ')}\n`);
  return lines.join('');
}

/** The read-only preflight of one selectable step, with the model/effort the user asked for. */
export interface StepPreflight {
  readonly step: SelectionStep;
  readonly provider: SelectionProvider;
  readonly requested: StepRequest;
  readonly claude?: ClaudePreflight;
  readonly codex?: CodexPreflight;
}

export function stepSelection(sp: StepPreflight): Selection {
  const selection = sp.claude?.selection ?? sp.codex?.selection;
  if (selection === undefined) throw new Error('step preflight has no provider result');
  return selection;
}

export function stepOk(sp: StepPreflight): boolean {
  return (sp.claude?.plan ?? sp.codex?.plan)?.ok === true;
}

export function stepWarnings(sp: StepPreflight): string {
  const plan = sp.claude?.plan ?? sp.codex?.plan;
  return plan?.ok === true ? plan.warnings.map((i) => `  warning: ${sp.step}: ${describeIssue(i)}\n`).join('') : '';
}

export function stepVerdict(sp: StepPreflight): string {
  if (sp.claude !== undefined) return sp.claude.plan.ok ? 'would run' : `would refuse: ${CLAUDE_REFUSALS[sp.claude.plan.reason]}`;
  const plan = sp.codex?.plan;
  return plan?.ok === false ? `would refuse: ${REFUSALS[plan.reason]}` : 'would run';
}

/** Why a step was refused: finding, setting and selection issue names only. */
export function stepDetails(sp: StepPreflight): string {
  if (sp.claude !== undefined) return claudeDetails(sp.claude);
  const plan = sp.codex?.plan;
  return plan?.ok === false ? plan.issues.map((i) => `      issue: ${describeIssue(i)}\n`).join('') : '';
}

function pinReason(flag: string, step: SelectionStep, fromFlag: boolean, value: string, policy?: { name: string; note: string }): string {
  if (!fromFlag && policy !== undefined) return `policy ${policy.name}: ${policy.note}`;
  if (!fromFlag) return 'no flag: the provider default is kept (which model or level that is, is decided by the provider and not known here)';
  return value === 'auto'
    ? `${flag} ${step}=auto: the provider default is kept, as above`
    : `requested with ${flag} ${step}=${value}`;
}

/** Model, effort, verification status and the reason for each, as dry-run lines. */
export function selectionLines(sp: StepPreflight): string {
  const selection = stepSelection(sp);
  const { request, modelFromFlag, effortFromFlag } = sp.requested;
  const explicit = [selection.model, selection.effort].filter((p) => p.kind === 'explicit');
  const status = selection.blocked
    ? 'BLOCKED (definite incompatibility)'
    : selection.issues.length > 0
      ? 'UNVERIFIED (needs --accept-unverified)'
      : explicit.length === 0
        ? 'nothing pinned, nothing to verify'
        : 'verified';
  return (
    `      model: ${describePinned(selection.model)}; reason: ${pinReason('--step-model', sp.step, modelFromFlag, request.model)}\n` +
    `      effort: ${describePinned(selection.effort)}; reason: ${pinReason('--step-effort', sp.step, effortFromFlag, request.effort, sp.requested.policy)}\n` +
    `      verification: ${status}\n` +
    selection.issues.map((i) => `      selection issue: ${describeIssue(i)}\n`).join('')
  );
}

/**
 * Runs the provider preflights for every selectable step of a workflow. Identical requests on the
 * same provider share one preflight. Nothing here calls a model.
 */
export async function preflightSteps(
  workflow: WorkflowName,
  requests: StepRequests,
  common: { task: string; acceptUnverified: boolean; cwd: string },
  deps: PreflightDeps,
): Promise<StepPreflight[]> {
  const cache = new Map<string, Promise<ClaudePreflight | CodexPreflight>>();
  const results: StepPreflight[] = [];
  for (const { step, provider } of selectionSteps(workflow)) {
    const requested = requests[step];
    if (requested === undefined) throw new Error(`no request for step ${step}`);
    const input = { ...common, request: requested.request };
    const key = `${provider}|${requested.request.model}|${requested.request.effort}`;
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = provider === 'claude' ? claudePreflight(input, deps) : codexPreflight(input, deps);
      cache.set(key, pending);
    }
    const pf = await pending;
    results.push({ step, provider, requested, ...(provider === 'claude' ? { claude: pf as ClaudePreflight } : { codex: pf as CodexPreflight }) });
  }
  return results;
}
