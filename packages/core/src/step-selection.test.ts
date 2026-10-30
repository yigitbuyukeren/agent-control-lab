import { describe, expect, it } from 'vitest';
import { buildStepRequests, selectionSteps } from './step-selection.ts';

describe('selectionSteps', () => {
  it('maps each workflow step to its provider', () => {
    expect(selectionSteps('plan-review')).toEqual([{ step: 'plan', provider: 'claude' }, { step: 'review', provider: 'codex' }]);
    expect(selectionSteps('plan-implement-review').map((s) => `${s.step}:${s.provider}`)).toEqual(['plan:claude', 'implement:codex', 'review:claude']);
  });
});

describe('buildStepRequests', () => {
  it('defaults every step to the provider default and never to ultracode', () => {
    const r = buildStepRequests('plan-implement-review', { models: [], efforts: [] });
    expect(r).toEqual({
      plan: { request: { model: 'auto', effort: 'auto', mode: 'normal' }, modelFromFlag: false, effortFromFlag: false },
      implement: { request: { model: 'auto', effort: 'auto', mode: 'normal' }, modelFromFlag: false, effortFromFlag: false },
      review: { request: { model: 'auto', effort: 'auto', mode: 'normal' }, modelFromFlag: false, effortFromFlag: false },
    });
  });

  it('applies settings per step, including an explicit auto', () => {
    const r = buildStepRequests('plan-review', { models: ['plan=auto', 'review=gpt-a'], efforts: ['review=low'] });
    expect(r).toMatchObject({
      plan: { request: { model: 'auto' }, modelFromFlag: true, effortFromFlag: false },
      review: { request: { model: 'gpt-a', effort: 'low', mode: 'normal' } },
    });
  });

  it.each([
    [{ models: ['plan'], efforts: [] }],
    [{ models: ['plan='], efforts: [] }],
    [{ models: ['=a'], efforts: [] }],
    [{ models: ['verify=a'], efforts: [] }],
    [{ models: ['implement=a'], efforts: [] }],
    [{ models: ['plan=a', 'plan=b'], efforts: [] }],
    [{ models: ['plan=a b'], efforts: [] }],
    [{ models: [], efforts: ['plan=ultracode'] }],
    [{ models: [], efforts: ['plan=Not Valid'] }],
  ])('refuses %j', (flags) => {
    expect(typeof buildStepRequests('plan-review', flags)).toBe('string');
  });
});
