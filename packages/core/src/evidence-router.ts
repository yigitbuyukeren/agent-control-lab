import { EVIDENCE_CATALOG, type EvidenceCatalog, type EvidenceEntry, type EvidenceSource, type TaskFit } from './evidence-catalog.ts';
import { levelRank, type TaskSize } from './step-policy.ts';
import type { SelectionStep } from './step-selection.ts';
import type { TaskSensitivity } from './step-router.ts';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** From the task text only: size class and the risky-keyword check. A heuristic, shown as one. */
export function difficultyOf(size: TaskSize, kind: TaskSensitivity): Difficulty {
  if (size === 'large' || kind === 'sensitive') return 'hard';
  return size === 'small' ? 'easy' : 'medium';
}

/** Which kind of benchmark says something about a step. A coding score says little about planning, and the reverse. */
export const STEP_FITS: Readonly<Record<SelectionStep, readonly TaskFit[]>> = {
  plan: ['reasoning'],
  review: ['reasoning'],
  implement: ['agentic-coding'],
};

/** Evidence older than this (days since it was read) is not used. */
export const MAX_EVIDENCE_AGE_DAYS = 120;
/** The smallest lead that counts as a difference; anything closer is treated as a tie. */
export const MIN_MARGIN: Readonly<Record<EvidenceEntry['metric'], number>> = { 'index-points': 3, percent: 5 };

export interface EvidenceInput {
  readonly step: SelectionStep;
  readonly provider: 'claude' | 'codex';
  readonly difficulty: Difficulty;
  /** The effort this step would aim for; evidence measured at a lower effort does not apply. */
  readonly targetEffort: string | undefined;
  /** Models this step could use. Codex: what the provider lists now. Claude: documented ids, access NOT verified. */
  readonly available: readonly string[];
  readonly now: Date;
  readonly catalog?: EvidenceCatalog;
}

export interface EvidenceDecision {
  /** A model the evidence supports and that is verifiably available (Codex only). */
  readonly model?: string;
  /** What the evidence favours when it cannot be applied (Claude access is never assumed). */
  readonly advisoryModel?: string;
  readonly note: string;
  readonly evidence: readonly string[];
}

const ageDays = (source: EvidenceSource, now: Date): number => (now.getTime() - Date.parse(`${source.retrieved}T00:00:00Z`)) / 86_400_000;

function describe(e: EvidenceEntry, source: EvidenceSource): string {
  return `${e.model} ${e.score === undefined ? 'no score' : String(e.score)}${e.metric === 'percent' ? '%' : ' points'}: ${e.benchmark} ${e.benchmarkVersion}, effort ${e.effort}, ${source.kind} (confidence ${e.confidence}), "${e.variant}"`;
}

/**
 * Recommends a model from published results, and only when the evidence is sufficient: same-benchmark,
 * same-version, same-effort scores of at least two models this step could use, from a source that is not a user
 * report, measured at an effort at least as high as the step aims for, recent, with a lead of at least `MIN_MARGIN`,
 * and either independently produced or confirmed by a second comparison. Anything else keeps the provider default.
 * Claude access is never assumed, so a Claude recommendation stays advisory.
 */
export function recommendFromEvidence(input: EvidenceInput): EvidenceDecision {
  const catalog = input.catalog ?? EVIDENCE_CATALOG;
  const byId = new Map(catalog.sources.map((s) => [s.id, s]));
  const evidence: string[] = [
    `evidence catalog ${catalog.version}: published results only; prices are not used (an API price says nothing about subscription quota)`,
    `step ${input.step} (${input.provider}), task difficulty ${input.difficulty} (heuristic), target effort ${input.targetEffort ?? 'unknown'}`,
  ];
  const keep = (why: string, advisoryModel?: string): EvidenceDecision => ({ note: `provider default kept: ${why}`, evidence, ...(advisoryModel === undefined ? {} : { advisoryModel }) });

  if (input.difficulty === 'easy') {
    return keep('an easy task does not call for a model chosen by benchmark leads; the models\' top scores say little about it');
  }
  const targetRank = input.targetEffort === undefined ? undefined : levelRank(input.targetEffort);
  if (targetRank === undefined) return keep('the target effort is unknown, so measured effort settings cannot be matched');

  const fits = STEP_FITS[input.step];
  const sets = new Map<string, EvidenceEntry[]>();
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const e of catalog.entries) {
    if (e.provider !== input.provider) continue;
    const source = byId.get(e.sourceId);
    if (source === undefined) continue;
    if (!fits.includes(e.fit)) continue;
    if (source.kind === 'community' || e.confidence === 'low') {
      notes.push(`supporting, low confidence, not used for the decision: ${describe(e, source)}${e.note === undefined ? '' : ` (${e.note})`}`);
      continue;
    }
    if (e.score === undefined) continue;
    if (ageDays(source, input.now) > MAX_EVIDENCE_AGE_DAYS) {
      skipped.push(`ignored (older than ${String(MAX_EVIDENCE_AGE_DAYS)} days): ${describe(e, source)}`);
      continue;
    }
    const rank = levelRank(e.effort);
    if (rank === undefined) {
      skipped.push(`ignored (effort ${e.effort} cannot be matched to this step's effort): ${describe(e, source)}`);
      continue;
    }
    if (rank < targetRank) {
      skipped.push(`ignored (measured at a lower effort than the ${input.targetEffort ?? ''} this step aims for): ${describe(e, source)}`);
      continue;
    }
    if (!input.available.includes(e.model)) {
      skipped.push(`ignored (${e.model} is not among the models this step can use now): ${describe(e, source)}`);
      continue;
    }
    const key = `${e.group}|${e.benchmark}|${e.benchmarkVersion}|${e.metric}|${e.effort}`;
    sets.set(key, [...(sets.get(key) ?? []), e]);
  }
  evidence.push(...skipped, ...notes);

  const winners: { model: string; independent: boolean }[] = [];
  for (const [, set] of sets) {
    const first = set[0];
    if (first === undefined) continue;
    const label = `${first.benchmark} ${first.benchmarkVersion} at effort ${first.effort}`;
    const ranked = [...set].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const e of ranked) {
      const source = byId.get(e.sourceId);
      if (source !== undefined) evidence.push(`${describe(e, source)}; source ${source.url} (published ${source.published ?? 'date not stated'}, read ${source.retrieved})`);
    }
    const [top, second] = ranked;
    if (top === undefined || second === undefined || new Set(ranked.map((e) => e.model)).size < 2) {
      evidence.push(`comparison ${label}: fewer than two comparable models, no decision`);
      continue;
    }
    const margin = (top.score ?? 0) - (second.score ?? 0);
    if (margin < MIN_MARGIN[top.metric]) {
      evidence.push(`comparison ${label}: lead of ${String(Math.round(margin * 10) / 10)} is below the ${String(MIN_MARGIN[top.metric])} needed to count as a difference`);
      continue;
    }
    evidence.push(`comparison ${label}: ${top.model} leads ${second.model} by ${String(Math.round(margin * 10) / 10)}`);
    winners.push({ model: top.model, independent: ranked.every((e) => e.confidence === 'high') });
  }

  if (winners.length === 0) return keep('no comparable, sufficient evidence for the models this step can use');
  const distinct = new Set(winners.map((w) => w.model));
  if (distinct.size > 1) return keep('the comparisons disagree about which model is better');
  const winner = winners[0]?.model;
  if (winner === undefined) return keep('no comparable, sufficient evidence');
  if (!winners.some((w) => w.independent) && winners.length < 2) {
    return keep(`${winner} leads in a single vendor-published comparison; an independent comparison or a second one is needed`);
  }
  if (input.provider === 'claude') {
    evidence.push('claude access: UNKNOWN (no command lists the models this account can use), so this is advice only');
    return keep(`the evidence favours ${winner}, but a Claude model cannot be shown to be accessible, so none is pinned`, winner);
  }
  return {
    model: winner,
    note: `${winner}: leads comparable published results (${String(winners.length)} comparison(s)) for ${input.step} work`,
    evidence,
  };
}
