import { EVIDENCE_CATALOG, type EvidenceCatalog, type EvidenceClaim, type EvidenceEntry, type EvidenceSource, type TaskFit } from './evidence-catalog.ts';
import type { TaskSize } from './step-policy.ts';
import type { SelectionStep } from './step-selection.ts';
import type { TaskSensitivity } from './step-router.ts';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** From the task text only: size class and the risky-keyword check. A heuristic, shown as one. */
export function difficultyOf(size: TaskSize, kind: TaskSensitivity): Difficulty {
  if (size === 'large' || kind === 'sensitive') return 'hard';
  return size === 'small' ? 'easy' : 'medium';
}

/**
 * Which kind of benchmark says something about a step. A general intelligence index, a computer-use or a business
 * workflow benchmark is not evidence about coding or code review, so those fits appear nowhere here: their results are
 * shown as context only.
 */
export const STEP_FITS: Readonly<Record<SelectionStep, readonly TaskFit[]>> = {
  plan: ['planning'],
  review: ['code-review'],
  implement: ['agentic-coding'],
};

/** Evidence older than this (days from its evaluation, publication or model release date) is not used. */
export const MAX_EVIDENCE_AGE_DAYS = 120;
/** The smallest lead that counts as a difference; anything closer is treated as a tie. */
export const MIN_MARGIN: Readonly<Record<EvidenceEntry['metric'], number>> = { 'index-points': 3, percent: 5 };

export interface EvidenceInput {
  readonly step: SelectionStep;
  readonly provider: 'claude' | 'codex';
  readonly difficulty: Difficulty;
  /** The effort this step will run at. Evidence counts only if it was measured at exactly this effort. */
  readonly targetEffort: string | undefined;
  /** Models this step could use. Codex: what the provider lists now. Claude: documented ids, access NOT verified. */
  readonly available: readonly string[];
  readonly now: Date;
  readonly catalog?: EvidenceCatalog;
}

export interface EvidenceDecision {
  /** A model the evidence supports and that is verifiably available (Codex only). */
  readonly model?: string;
  /** The effort the supporting evidence was measured at (equal to the target). */
  readonly evidenceEffort?: string;
  /** What the evidence favours when it cannot be applied (Claude access is never assumed). */
  readonly advisoryModel?: string;
  readonly note: string;
  readonly evidence: readonly string[];
}

/** The date freshness is counted from: the evaluation, else the publication, else the model release. Never the read date. */
function freshnessDate(source: EvidenceSource): { date: string; basis: string } | undefined {
  if (source.evaluated !== undefined) return { date: source.evaluated, basis: 'evaluation' };
  if (source.published !== undefined) return { date: source.published, basis: 'publication' };
  if (source.modelReleased !== undefined) return { date: source.modelReleased, basis: 'model release' };
  return undefined;
}

function dates(source: EvidenceSource): string {
  return [
    source.evaluated === undefined ? 'evaluation date not stated by the source' : `evaluated ${source.evaluated}`,
    source.published === undefined ? undefined : `published ${source.published}`,
    source.modelReleased === undefined ? undefined : `model released ${source.modelReleased}`,
    `page read ${source.retrieved}`,
  ]
    .filter((x): x is string => x !== undefined)
    .join(', ');
}

const unit = (e: EvidenceEntry): string => (e.metric === 'percent' ? '%' : ' points');

function describe(e: EvidenceEntry, source: EvidenceSource): string {
  return `${e.model} ${e.score === undefined ? 'no score' : `${String(e.score)}${unit(e)}`}: ${e.benchmark} ${e.benchmarkVersion}, effort ${e.effort}, ${source.kind} (confidence ${e.confidence}), "${e.variant}"`;
}

function describeClaim(c: EvidenceClaim, source: EvidenceSource): string {
  return `${c.model} ahead of ${c.versus} by ${String(c.delta)} points: ${c.benchmark} ${c.benchmarkVersion}, effort ${c.effort} vs ${c.versusEffort}, ${source.kind} (confidence ${c.confidence}), a stated difference, not each model's score`;
}

const round = (x: number): number => Math.round(x * 10) / 10;

/**
 * Recommends a model from published results, and only when the evidence is sufficient and fits the step: same
 * benchmark, version, harness and effort for at least two models this step could use, a benchmark that measures this
 * kind of work, an effort identical to the one the step will run at, a source that is not a user report, a known date
 * that is recent, a lead of at least `MIN_MARGIN`, and either an independently produced comparison or two agreeing ones.
 * Anything else keeps the provider default. Claude access is never assumed, so a Claude recommendation stays advisory.
 */
export function recommendFromEvidence(input: EvidenceInput): EvidenceDecision {
  const catalog = input.catalog ?? EVIDENCE_CATALOG;
  const byId = new Map(catalog.sources.map((s) => [s.id, s]));
  const evidence: string[] = [
    `evidence catalog ${catalog.version}: published results only; re-reading a page does not refresh a benchmark; prices are not used (an API price says nothing about subscription quota)`,
    `step ${input.step} (${input.provider}), task difficulty ${input.difficulty} (heuristic), the step will run at effort ${input.targetEffort ?? 'unknown'}`,
  ];
  const keep = (why: string, advisoryModel?: string): EvidenceDecision => ({ note: `provider default kept: ${why}`, evidence, ...(advisoryModel === undefined ? {} : { advisoryModel }) });

  if (input.difficulty === 'easy') {
    return keep("an easy task does not call for a model chosen by benchmark leads; the models' top scores say little about it");
  }
  const target = input.targetEffort;
  if (target === undefined) return keep('the effort this step will run at is unknown, so measured effort settings cannot be matched');

  const fits = STEP_FITS[input.step];
  const sets = new Map<string, { entries: EvidenceEntry[] }>();
  const pairs: { claim: EvidenceClaim; source: EvidenceSource }[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const context = new Map<string, string[]>();

  const usable = (item: EvidenceEntry | EvidenceClaim, source: EvidenceSource, text: string, efforts: string[], models: string[]): boolean => {
    const reasons: string[] = [];
    if (item.harness === 'unspecified') reasons.push('harness not stated');
    const fresh = freshnessDate(source);
    if (fresh === undefined) {
      reasons.push('the source states no evaluation, publication or release date, so freshness is unknown');
    } else if ((input.now.getTime() - Date.parse(`${fresh.date}T00:00:00Z`)) / 86_400_000 > MAX_EVIDENCE_AGE_DAYS) {
      reasons.push(`${fresh.basis} date ${fresh.date} is older than ${String(MAX_EVIDENCE_AGE_DAYS)} days`);
    }
    for (const effort of new Set(efforts)) {
      if (effort === 'unspecified') reasons.push('effort not stated, so it cannot be matched to this step');
      else if (effort !== target) reasons.push(`measured at effort ${effort}, but this step runs at ${target}; results at different efforts are not equivalent`);
    }
    const missing = models.filter((m) => !input.available.includes(m));
    if (missing.length > 0) reasons.push(`${missing.join(', ')} not among the models this step can use now`);
    if (reasons.length > 0) skipped.push(`ignored (${reasons.join('; ')}): ${text}`);
    return reasons.length === 0;
  };

  for (const e of catalog.entries) {
    if (e.provider !== input.provider) continue;
    const source = byId.get(e.sourceId);
    if (source === undefined) continue;
    if (!fits.includes(e.fit)) {
      const key = `${e.benchmark} ${e.benchmarkVersion} (${e.fit})`;
      context.set(key, [...(context.get(key) ?? []), `${e.model} ${e.score === undefined ? 'no score' : `${String(e.score)}${unit(e)}`}`]);
      continue;
    }
    if (source.kind === 'community' || e.confidence === 'low') {
      notes.push(`supporting, low confidence, not used for the decision: ${describe(e, source)}${e.note === undefined ? '' : ` (${e.note})`}`);
      continue;
    }
    if (e.score === undefined) continue;
    if (!usable(e, source, `${describe(e, source)}; ${dates(source)}`, [e.effort], [e.model])) continue;
    const key = `${e.group}|${e.benchmark}|${e.benchmarkVersion}|${e.metric}|${e.harness}|${e.effort}`;
    sets.set(key, { entries: [...(sets.get(key)?.entries ?? []), e] });
  }
  for (const c of catalog.claims) {
    if (c.provider !== input.provider) continue;
    const source = byId.get(c.sourceId);
    if (source === undefined) continue;
    if (!fits.includes(c.fit)) {
      const key = `${c.benchmark} ${c.benchmarkVersion} (${c.fit})`;
      context.set(key, [...(context.get(key) ?? []), `${c.model} +${String(c.delta)} points over ${c.versus}`]);
      continue;
    }
    if (c.confidence === 'low' || source.kind === 'community') continue;
    if (usable(c, source, `${describeClaim(c, source)}; ${dates(source)}`, [c.effort, c.versusEffort], [c.model, c.versus])) pairs.push({ claim: c, source });
  }
  for (const [key, list] of context) {
    evidence.push(`context only, not evidence for ${input.step} work: ${key}: ${list.join(', ')}`);
  }
  evidence.push(...skipped, ...notes);

  const winners: { model: string; independent: boolean; effort: string }[] = [];
  for (const [, { entries: set }] of sets) {
    const first = set[0];
    if (first === undefined) continue;
    const label = `${first.benchmark} ${first.benchmarkVersion} at effort ${first.effort}`;
    const ranked = [...set].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const e of ranked) {
      const source = byId.get(e.sourceId);
      if (source !== undefined) evidence.push(`${describe(e, source)}; source ${source.url} (${dates(source)}; harness: ${e.harness})`);
    }
    const [top, second] = ranked;
    if (top === undefined || second === undefined || new Set(ranked.map((e) => e.model)).size < 2) {
      evidence.push(`comparison ${label}: fewer than two comparable models, no decision`);
      continue;
    }
    const margin = (top.score ?? 0) - (second.score ?? 0);
    if (margin < MIN_MARGIN[top.metric]) {
      evidence.push(`comparison ${label}: lead of ${String(round(margin))} is below the ${String(MIN_MARGIN[top.metric])} needed to count as a difference`);
      continue;
    }
    evidence.push(`comparison ${label}: ${top.model} leads ${second.model} by ${String(round(margin))}`);
    winners.push({ model: top.model, independent: ranked.every((e) => e.confidence === 'high'), effort: first.effort });
  }
  for (const { claim, source } of pairs) {
    evidence.push(`${describeClaim(claim, source)}; source ${source.url} (${dates(source)}; harness: ${claim.harness})`);
    if (Math.abs(claim.delta) < MIN_MARGIN.percent) {
      evidence.push(`stated difference of ${String(claim.delta)} is below the ${String(MIN_MARGIN.percent)} needed to count as a difference`);
      continue;
    }
    winners.push({ model: claim.delta > 0 ? claim.model : claim.versus, independent: false, effort: claim.effort });
  }

  if (winners.length === 0) return keep('no comparable evidence of the right kind for the models this step can use');
  const distinct = new Set(winners.map((w) => w.model));
  if (distinct.size > 1) return keep('the comparisons disagree about which model is better');
  const winner = winners[0];
  if (winner === undefined) return keep('no comparable evidence');
  if (!winners.some((w) => w.independent) && winners.length < 2) {
    return keep(`${winner.model} leads in a single vendor-published comparison; an independent comparison or a second one is needed`);
  }
  if (input.provider === 'claude') {
    evidence.push('claude access: UNKNOWN (no command lists the models this account can use), so this is advice only');
    return keep(`the evidence favours ${winner.model}, but a Claude model cannot be shown to be accessible, so none is pinned`, winner.model);
  }
  return {
    model: winner.model,
    evidenceEffort: winner.effort,
    note: `${winner.model}: leads comparable published results (${String(winners.length)} comparison(s)) for ${input.step} work, measured at effort ${winner.effort}`,
    evidence,
  };
}
