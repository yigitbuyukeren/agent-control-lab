import { describe, expect, it } from 'vitest';
import type { CodexModelsResult, ModelCapability } from './models.ts';
import { classifyTask, isModelRouting, routeModel, type ModelRouteInput } from './step-router.ts';

const model = (id: string, supported: string[] | undefined): ModelCapability => ({
  provider: 'codex',
  id,
  source: 'discovered',
  access: 'listed',
  efforts: supported === undefined ? { status: 'unknown' } : { status: 'known', supported },
  modes: { ultracode: 'unsupported' },
});
const ok = (...models: ModelCapability[]): CodexModelsResult => ({ state: 'ok', models });
const input = (over: Partial<ModelRouteInput> = {}): ModelRouteInput => ({
  step: 'review',
  provider: 'codex',
  policy: 'quality',
  size: 'normal',
  kind: 'general',
  catalog: ok(model('a', ['low', 'medium']), model('b', ['low', 'medium', 'high'])),
  quota: 'ok',
  ...over,
});

describe('classifyTask / isModelRouting', () => {
  it('flags risky areas by keyword only', () => {
    expect(classifyTask('fix the auth token handling')).toBe('sensitive');
    expect(classifyTask('veritabanı migrasyon adımı')).toBe('sensitive');
    expect(classifyTask('rename a variable')).toBe('general');
    expect(classifyTask('author list page')).toBe('general');
  });
  it('knows its two modes', () => {
    expect(isModelRouting('adaptive')).toBe(true);
    expect(isModelRouting('auto')).toBe(true);
    expect(isModelRouting('smart')).toBe(false);
  });
});

describe('routeModel', () => {
  it('pins the only listed model that supports the target effort, with its evidence', () => {
    const d = routeModel(input());
    expect(d.model).toBe('b');
    expect(d.note).toContain('only listed model that supports high');
    expect(d.evidence.join('\n')).toMatch(/target effort: high \(quality base high/);
    expect(d.evidence.join('\n')).toContain('models supporting high: b');
  });

  it('never pins a Claude model: access cannot be shown', () => {
    const d = routeModel(input({ step: 'plan', provider: 'claude' }));
    expect(d.model).toBeUndefined();
    expect(d.evidence.join('\n')).toContain('UNKNOWN');
  });

  it('keeps the default when it cannot tell models apart or has nothing to go on', () => {
    for (const catalog of [
      ok(model('a', ['low', 'medium', 'high']), model('b', ['low', 'medium', 'high'])),
      ok(model('a', ['low']), model('b', ['low'])),
      ok(model('a', ['high']), model('b', ['high']), model('c', ['low'])),
      ok(model('a', ['high']), model('b', undefined)),
      ok(model('a', ['high'])),
      { state: 'error', error: 'x' } as CodexModelsResult,
      { state: 'not-installed' } as CodexModelsResult,
      undefined,
    ]) {
      const d = routeModel(input({ catalog }));
      expect(d.model).toBeUndefined();
      expect(d.note).toContain('provider default kept');
    }
  });

  it('follows the target: a lower quota or a small task needs a lower level', () => {
    const catalog = ok(model('a', ['low']), model('b', ['low', 'medium', 'high']));
    expect(routeModel(input({ catalog, size: 'small' })).model).toBe('b');
    expect(routeModel(input({ catalog, policy: 'economy' })).model).toBeUndefined();
    expect(routeModel(input({ catalog, policy: 'balanced', size: 'normal', kind: 'sensitive' })).model).toBe('b');
  });
});
