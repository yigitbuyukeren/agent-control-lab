import { OUTCOME_KINDS, type OutcomeKind, type OutcomeRecord } from './outcome-record.ts';
import type { TaskSize } from './step-policy.ts';
import type { SelectionStep } from './step-selection.ts';
import type { TaskSensitivity } from './step-router.ts';

/** Measured outcomes (pass + fail) a group needs before it counts. */
export const MIN_MEASURED = 8;
/** Records older than this are ignored: models and providers change. */
export const MAX_AGE_DAYS = 90;

export interface MeasureKey {
  readonly provider: 'claude' | 'codex';
  readonly step: SelectionStep;
  readonly task: TaskSensitivity;
  readonly size: TaskSize;
}

export interface MeasuredGroup {
  readonly model: string;
  readonly effort: string;
  readonly counts: Readonly<Record<OutcomeKind, number>>;
  /** pass + fail */
  readonly measured: number;
  readonly rate: number;
  /** 95% Wilson interval of the pass rate. */
  readonly low: number;
  readonly high: number;
  readonly medianSeconds: number;
  readonly eligible: boolean;
}

export function wilson(pass: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = pass / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Groups comparable records (same provider, step, task type and size) by model and effort. */
export function groupOutcomes(records: readonly OutcomeRecord[], key: MeasureKey, now: Date): MeasuredGroup[] {
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;
  const groups = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    if (r.provider !== key.provider || r.step !== key.step || r.task !== key.task || r.size !== key.size) continue;
    if (Date.parse(`${r.day}T00:00:00Z`) < cutoff) continue;
    const k = `${r.model}\u0000${r.effort}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()]
    .map((rs) => {
      const counts = Object.fromEntries(OUTCOME_KINDS.map((k) => [k, rs.filter((r) => r.outcome === k).length])) as Record<OutcomeKind, number>;
      const measured = counts.pass + counts.fail;
      const { low, high } = wilson(counts.pass, measured);
      return {
        model: rs[0]?.model ?? 'default',
        effort: rs[0]?.effort ?? 'default',
        counts,
        measured,
        rate: measured === 0 ? 0 : counts.pass / measured,
        low,
        high,
        medianSeconds: median(rs.filter((r) => r.outcome === 'pass' || r.outcome === 'fail').map((r) => r.seconds)),
        eligible: measured >= MIN_MEASURED,
      };
    })
    .sort((a, b) => b.measured - a.measured || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
}

export interface MeasuredDecision {
  /** Present only when one group is clearly better than every other eligible group and is not the default. */
  readonly choice?: { readonly model: string; readonly effort: string };
  readonly note: string;
  readonly evidence: readonly string[];
}

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

/**
 * Chooses only when at least two comparable groups each have `MIN_MEASURED` measured outcomes and the best
 * one's 95% interval lies entirely above every other eligible group's. Overlapping intervals, too little data or
 * a single group mean "no decision": the provider default is kept. Duration is shown, never used to choose.
 */
export function chooseMeasured(records: readonly OutcomeRecord[], key: MeasureKey, now: Date): MeasuredDecision {
  const groups = groupOutcomes(records, key, now);
  const total = groups.reduce((n, g) => n + g.measured, 0);
  const evidence = [
    `measurement key: ${key.provider} ${key.step}, ${key.task} task, ${key.size} size; last ${String(MAX_AGE_DAYS)} days; needs ${String(MIN_MEASURED)}+ measured outcomes per group and 2+ groups`,
    `measured outcomes (pass or fail by a local check, never the model's own claim): ${String(total)} in ${String(groups.length)} group(s)`,
    ...groups.map(
      (g) =>
        `  ${g.model} / ${g.effort}: ${String(g.counts.pass)} pass, ${String(g.counts.fail)} fail (rate ${pct(g.rate)}, 95% interval ${pct(g.low)}-${pct(g.high)}), ${String(g.counts.error + g.counts.timeout)} error/timeout, ${String(g.counts.unmeasured)} unmeasured, median ${String(g.medianSeconds)}s${g.eligible ? '' : ' (too few to count)'}`,
    ),
  ];
  const eligible = groups.filter((g) => g.eligible);
  if (eligible.length < 2) {
    return { note: `provider default kept: not enough comparable data (${String(eligible.length)} group(s) with ${String(MIN_MEASURED)}+ measured outcomes, 2 needed)`, evidence };
  }
  const best = [...eligible].sort((a, b) => b.low - a.low)[0];
  if (best === undefined) return { note: 'provider default kept: no data', evidence };
  const rivals = eligible.filter((g) => g !== best);
  if (!rivals.every((g) => best.low > g.high)) {
    evidence.push(`uncertainty: the best group (${best.model} / ${best.effort}) is not clearly better: its interval overlaps another group's`);
    return { note: 'provider default kept: the measured difference is within the uncertainty', evidence };
  }
  evidence.push(`uncertainty: ${best.model} / ${best.effort} lower bound ${pct(best.low)} exceeds every other group's upper bound`);
  if (best.model === 'default') return { note: 'provider default kept: the default measured clearly best', evidence };
  return { choice: { model: best.model, effort: best.effort }, note: `${best.model} / ${best.effort}: measurably better than every other comparable group`, evidence };
}
