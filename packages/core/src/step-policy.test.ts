import { describe, expect, it } from 'vitest';
import type { ModelCapability } from './models.ts';
import { decideEffort, estimateTaskSize, isPolicyName, type PolicyInput } from './step-policy.ts';

const model = (supported: string[] | undefined): ModelCapability => ({
  provider: 'codex',
  id: 'gpt-a',
  source: 'discovered',
  access: 'listed',
  efforts: supported === undefined ? { status: 'unknown' } : { status: 'known', supported },
  modes: { ultracode: 'unsupported' },
});
const pinned = (supported: string[] | undefined): PolicyInput['model'] => ({ kind: 'pinned', id: 'gpt-a', capability: model(supported) });
const ALL = ['low', 'medium', 'high', 'xhigh'];
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({ policy: 'balanced', step: 'implement', size: 'normal', model: pinned(ALL), quota: 'ok', ...over });

describe('estimateTaskSize', () => {
  it('classes by text length and lines only', () => {
    expect(estimateTaskSize('add a flag')).toBe('small');
    expect(estimateTaskSize('x'.repeat(300))).toBe('normal');
    expect(estimateTaskSize('x'.repeat(900))).toBe('large');
    expect(estimateTaskSize(Array.from({ length: 12 }, () => 'a').join('\n'))).toBe('large');
  });
});

describe('decideEffort: no verified data means the provider default', () => {
  it('keeps the default when the model is not pinned', () => {
    const d = decideEffort(input({ model: { kind: 'auto' } }));
    expect(d.effort).toBeUndefined();
    expect(d.note).toContain('provider default kept');
  });

  it('keeps the default when the pinned model is unknown or its efforts are not known', () => {
    for (const m of [{ kind: 'pinned', id: 'x', capability: undefined }, pinned(undefined)] as const) {
      const d = decideEffort(input({ model: m }));
      expect(d.effort).toBeUndefined();
      expect(d.note).toContain('not verified');
    }
  });

  it('keeps the default when no supported level can be ordered, and never yields ultracode', () => {
    expect(decideEffort(input({ model: pinned(['ultra', 'ultracode']) })).effort).toBeUndefined();
    for (const policy of ['economy', 'balanced', 'quality'] as const) {
      for (const size of ['small', 'normal', 'large'] as const) {
        expect(decideEffort(input({ policy, size, model: pinned([...ALL, 'ultracode']) })).effort).not.toBe('ultracode');
      }
    }
  });
});

describe('decideEffort: policy, role, size and quota', () => {
  it('orders economy < balanced < quality on the same verified model', () => {
    const pick = (policy: 'economy' | 'balanced' | 'quality') => decideEffort(input({ policy })).effort;
    expect([pick('economy'), pick('balanced'), pick('quality')]).toEqual(['low', 'medium', 'high']);
  });

  it('gives the plan step one more level under quality only', () => {
    expect(decideEffort(input({ policy: 'quality', step: 'plan' })).effort).toBe('xhigh');
    expect(decideEffort(input({ policy: 'balanced', step: 'plan' })).effort).toBe('medium');
  });

  it('moves one level with the task size, but never below the economy base', () => {
    expect(decideEffort(input({ size: 'large' })).effort).toBe('high');
    expect(decideEffort(input({ size: 'small' })).effort).toBe('low');
    expect(decideEffort(input({ policy: 'economy', size: 'small' })).effort).toBe('low');
  });

  it('lowers one level on a known low, critical or exhausted quota and ignores an unknown one', () => {
    for (const quota of ['low', 'critical', 'exhausted'] as const) {
      const d = decideEffort(input({ quota }));
      expect(d.effort).toBe('low');
      expect(d.note).toContain(`quota ${quota}`);
    }
    const unknown = decideEffort(input({ quota: 'unknown' }));
    expect(unknown.effort).toBe('medium');
    expect(unknown.note).toContain('quota unknown, not used');
  });

  it('stays within what the model supports', () => {
    expect(decideEffort(input({ policy: 'quality', model: pinned(['low', 'medium']) })).effort).toBe('medium');
    const raised = decideEffort(input({ policy: 'economy', model: pinned(['high', 'xhigh']) }));
    expect(raised.effort).toBe('high');
    expect(raised.note).toContain('lowest level');
  });
});

describe('isPolicyName', () => {
  it('accepts exactly the three policies', () => {
    expect(['economy', 'balanced', 'quality'].every(isPolicyName)).toBe(true);
    expect(['auto', 'ultracode', ''].some(isPolicyName)).toBe(false);
  });
});
