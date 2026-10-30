import { describe, expect, it } from 'vitest';
import type { StepResult, WorkflowResult } from './orchestration.ts';
import { parseOutcomeLine, recordsFromRun, serializeOutcome, type OutcomeKind, type OutcomeRecord, type RunFacts } from './outcome-record.ts';
import { chooseMeasured, groupOutcomes, MIN_MEASURED, wilson, type MeasureKey } from './outcome-stats.ts';

const NOW = new Date('2026-10-30T00:00:00Z');
const KEY: MeasureKey = { provider: 'codex', step: 'implement', task: 'general', size: 'small' };
const rec = (model: string, effort: string, outcome: OutcomeKind, over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  v: 1, day: '2026-10-20', step: 'implement', provider: 'codex', model, effort, task: 'general', size: 'small', outcome, seconds: 30, ...over,
});
const many = (model: string, effort: string, pass: number, fail: number, over: Partial<OutcomeRecord> = {}): OutcomeRecord[] => [
  ...Array.from({ length: pass }, () => rec(model, effort, 'pass', over)),
  ...Array.from({ length: fail }, () => rec(model, effort, 'fail', over)),
];

const step = (id: string, status: StepResult['status'], over: Partial<StepResult> = {}): StepResult => ({ id, title: id, provider: 'local', status, durationMs: 4200, ...over });
const run = (steps: StepResult[]): WorkflowResult => ({ workflow: 'plan-implement-review', steps, status: 'completed', partial: false });
const FACTS: RunFacts = {
  day: '2026-10-30', task: 'general', size: 'small',
  steps: { plan: { provider: 'claude', model: 'auto', effort: 'auto' }, implement: { provider: 'codex', model: 'gpt-a', effort: 'low' }, review: { provider: 'claude', model: 'auto', effort: 'auto' } },
};

describe('recordsFromRun: only local checks are evidence', () => {
  const base = [step('plan', 'completed'), step('implement', 'completed', { output: 'I am sure it works' }), step('inspect', 'completed')];
  const outcomeOf = (steps: StepResult[]) => recordsFromRun(run(steps), FACTS).find((r) => r.step === 'implement')?.outcome;

  it('pass needs a passing verification; failures come from verification or inspection', () => {
    expect(outcomeOf([...base, step('verify', 'completed'), step('review', 'completed', { output: 'VERDICT: approve' })])).toBe('pass');
    expect(outcomeOf([...base, step('verify', 'failed')])).toBe('fail');
    expect(outcomeOf([step('plan', 'completed'), step('implement', 'completed'), step('inspect', 'failed')])).toBe('fail');
  });

  it('a model claim or an approving review without a local check is unmeasured', () => {
    expect(outcomeOf([...base, step('review', 'completed', { output: 'VERDICT: approve, all tests pass' })])).toBe('unmeasured');
  });

  it('provider failures are error/timeout, cancelled and skipped steps leave nothing, and defaults are named', () => {
    expect(outcomeOf([step('plan', 'completed'), step('implement', 'failed')])).toBe('error');
    expect(outcomeOf([step('plan', 'completed'), step('implement', 'timeout')])).toBe('timeout');
    const records = recordsFromRun(run([step('plan', 'completed'), step('implement', 'cancelled'), step('review', 'skipped')]), FACTS);
    expect(records.map((r) => r.step)).toEqual(['plan']);
    expect(records[0]).toMatchObject({ model: 'default', effort: 'default', seconds: 4 });
  });

  it('keeps no task text, output, path or session id', () => {
    const text = recordsFromRun(run([...base, step('verify', 'completed', { output: '/Users/me/secret SESSION-SECRET' })]), FACTS).map(serializeOutcome).join('\n');
    expect(text).not.toMatch(/secret|SESSION|Users|sure it works/i);
    expect(Object.keys(JSON.parse(text.split('\n')[0] ?? '{}') as object).sort()).toEqual(['day', 'effort', 'model', 'outcome', 'provider', 'seconds', 'size', 'step', 'task', 'v']);
  });
});

describe('parseOutcomeLine', () => {
  it('round-trips and rejects anything malformed or out of range', () => {
    const r = rec('gpt-a', 'low', 'pass');
    expect(parseOutcomeLine(serializeOutcome(r))).toEqual(r);
    for (const bad of ['', 'x', '[]', JSON.stringify({ ...r, v: 2 }), JSON.stringify({ ...r, model: 'bad id!' }), JSON.stringify({ ...r, effort: 'ultracode' }), JSON.stringify({ ...r, outcome: 'great' }), JSON.stringify({ ...r, seconds: -1 }), JSON.stringify({ ...r, day: 'today' })]) {
      expect(parseOutcomeLine(bad)).toBeUndefined();
    }
    expect(parseOutcomeLine(JSON.stringify({ ...r, task: 'secret text' }))).toBeUndefined();
    expect(parseOutcomeLine(JSON.stringify({ ...r, extra: 'dropped' }))).toEqual(r);
  });
});

describe('groupOutcomes / chooseMeasured', () => {
  it('only compares the same provider, step, task type and size, and ignores old records', () => {
    const records = [...many('a', 'low', 3, 0), ...many('a', 'low', 5, 0, { task: 'sensitive' }), ...many('a', 'low', 5, 0, { day: '2026-05-01' }), ...many('a', 'low', 5, 0, { step: 'review' })];
    const groups = groupOutcomes(records, KEY, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ measured: 3, eligible: false });
  });

  it('keeps the default without enough data, with one group, or with overlapping intervals', () => {
    for (const records of [[], many('a', 'low', MIN_MEASURED - 1, 0), many('a', 'low', 12, 0), [...many('a', 'low', 9, 1), ...many('default', 'default', 8, 2)]]) {
      const d = chooseMeasured(records, KEY, NOW);
      expect(d.choice).toBeUndefined();
      expect(d.note).toContain('provider default kept');
    }
    const overlap = chooseMeasured([...many('a', 'low', 9, 1), ...many('default', 'default', 8, 2)], KEY, NOW);
    expect(overlap.note).toContain('within the uncertainty');
    expect(overlap.evidence.join('\n')).toContain('not clearly better');
  });

  it('chooses a model that is clearly better, and shows counts and intervals', () => {
    const d = chooseMeasured([...many('gpt-a', 'low', 20, 0), ...many('default', 'default', 5, 10)], KEY, NOW);
    expect(d.choice).toEqual({ model: 'gpt-a', effort: 'low' });
    const text = d.evidence.join('\n');
    expect(text).toContain('gpt-a / low: 20 pass, 0 fail');
    expect(text).toContain('default / default: 5 pass, 10 fail');
    expect(text).toContain('95% interval');
  });

  it('keeps the default when the default itself is clearly best, and never counts unmeasured or errors as passes', () => {
    const best = chooseMeasured([...many('default', 'default', 20, 0), ...many('gpt-a', 'low', 5, 10)], KEY, NOW);
    expect(best.choice).toBeUndefined();
    expect(best.note).toContain('default measured clearly best');
    const noise = Array.from({ length: 30 }, () => rec('gpt-a', 'low', 'unmeasured'));
    expect(groupOutcomes(noise, KEY, NOW)[0]).toMatchObject({ measured: 0, eligible: false });
  });

  it('wilson is wide for small samples', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(3, 3).low).toBeLessThan(0.5);
    expect(wilson(50, 50).low).toBeGreaterThan(0.9);
  });
});
