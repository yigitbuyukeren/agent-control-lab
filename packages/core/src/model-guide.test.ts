import { describe, expect, it } from 'vitest';
import { GUIDE_RELATIONS, GUIDE_SOURCES, guideModel, intentFor, MODEL_PROFILES, type GuideInput } from './model-guide.ts';

const CODEX = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];
const input = (over: Partial<GuideInput> = {}): GuideInput => ({
  step: 'implement', provider: 'codex', difficulty: 'hard', size: 'normal', policy: 'balanced', available: CODEX, ...over,
});

describe('the guide data', () => {
  it('points every profile and relation at a known https source and a known model', () => {
    const sources = new Set(GUIDE_SOURCES.map((s) => s.id));
    const ids = new Set(MODEL_PROFILES.map((p) => p.id));
    for (const s of GUIDE_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const p of MODEL_PROFILES) {
      expect(sources.has(p.sourceId)).toBe(true);
      expect(p.positioning).not.toBe('');
    }
    for (const r of GUIDE_RELATIONS) {
      expect(sources.has(r.sourceId)).toBe(true);
      expect(ids.has(r.better) && ids.has(r.than)).toBe(true);
    }
  });

  it('records no prices and no benchmark scores', () => {
    expect(JSON.stringify({ MODEL_PROFILES, GUIDE_RELATIONS })).not.toMatch(/\$\d|price|score|%/i);
  });
});

describe('intentFor', () => {
  it('maps step and difficulty to a kind of work, and does not downsize under quality', () => {
    expect(intentFor('implement', 'hard', 'balanced')).toBe('complex-coding');
    expect(intentFor('implement', 'medium', 'economy')).toBe('complex-coding');
    expect(intentFor('implement', 'easy', 'balanced')).toBe('focused-coding');
    expect(intentFor('implement', 'easy', 'quality')).toBe('complex-coding');
    expect(intentFor('review', 'hard', 'balanced')).toBe('complex-work');
    expect(intentFor('plan', 'easy', 'economy')).toBe('focused-work');
  });
});

describe('guideModel for Codex', () => {
  it('follows the policy among the models documented for complex coding, using only stated relations', () => {
    expect(guideModel(input({ policy: 'quality' })).model).toBe('gpt-6-astra');
    expect(guideModel(input({ policy: 'economy' })).model).toBe('gpt-6.1-sol');
    expect(guideModel(input({ policy: 'balanced' })).model).toBe('gpt-6.1-sol');
  });

  it('shows what it rests on: documentation, sources, the relation used, and that Terra is less suited', () => {
    const d = guideModel(input({ policy: 'quality' }));
    const text = d.lines.join('\n');
    expect(d.uncertainty).toBe('medium');
    expect(d.note).toContain('intent-based, not measured');
    expect(text).toContain('vendor documentation, not measurements');
    expect(text).toContain('suited by documentation: gpt-6.1-sol');
    expect(text).toContain('https://developers.openai.com/api/docs/guides/latest-model, read 2026-10-31');
    expect(text).toContain('capability: gpt-6-astra ahead of gpt-6.1-sol');
    expect(text).toContain('vendor says less suited for complex-coding: gpt-6.1-terra');
    expect(text).toContain('not named for complex-coding: gpt-6-luna');
  });

  it('picks the documented small model for focused work, but not under the quality policy', () => {
    expect(guideModel(input({ difficulty: 'easy' })).model).toBe('gpt-6-luna');
    expect(guideModel(input({ difficulty: 'easy', policy: 'economy' })).model).toBe('gpt-6-luna');
    expect(guideModel(input({ difficulty: 'easy', policy: 'quality' })).model).toBe('gpt-6-astra');
  });

  it('never picks Terra for complex coding, and keeps the default when nothing documented is available', () => {
    expect(guideModel(input({ available: ['gpt-6.1-terra'] })).model).toBeUndefined();
    expect(guideModel(input({ available: ['gpt-9-unknown'] })).model).toBeUndefined();
    expect(guideModel(input({ available: [] })).note).toContain('provider default kept');
    const undocumented = guideModel(input({ available: ['gpt-9-unknown', 'gpt-6-astra'] }));
    expect(undocumented.model).toBe('gpt-6-astra');
    expect(undocumented.lines.join('\n')).toContain('gpt-9-unknown: no documented purpose');
  });

  it('keeps the default when documentation does not settle the priority', () => {
    const d = guideModel(input({ available: ['gpt-6-astra', 'gpt-6.1-sol'], policy: 'economy', provider: 'codex', step: 'implement' }));
    expect(d.model).toBe('gpt-6.1-sol');
    const none = guideModel(input({ provider: 'claude', step: 'plan', available: ['claude-fable-5-1', 'claude-opus-5-5'], policy: 'quality' }));
    expect(none.model).toBeUndefined();
    expect(none.advisoryModel).toBeUndefined();
    expect(none.note).toContain('does not settle');
  });
});

describe('guideModel for Claude: advice only', () => {
  it('names what the documentation points to but never pins it', () => {
    const d = guideModel(input({ provider: 'claude', step: 'implement', available: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] }));
    expect(d.model).toBeUndefined();
    expect(d.advisoryModel).toBe('claude-opus-5-5');
    expect(d.uncertainty).toBe('high');
    expect(d.lines.join('\n')).toContain('claude access: UNKNOWN');
  });
});
