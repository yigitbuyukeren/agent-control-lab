import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_LEVELS,
  asEffortLevel,
  checkEffort,
  claudeRegistry,
  discoverCodexModels,
  parseCodexModel,
  type ModelCapability,
} from './models.ts';
import type { AppServerProcess, AppServerSpawn } from './quota.ts';

type Handler = (method: string, params: Record<string, unknown> | undefined) => unknown;

/** Scripted app-server: `handler` returns a result, or throws to send an error response. */
function server(handler: Handler) {
  const state = { killed: 0, methods: [] as string[] };
  const spawnServer: AppServerSpawn = () => {
    let lineCb: (line: string) => void = () => undefined;
    const proc: AppServerProcess = {
      send(line) {
        const m = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
        state.methods.push(m.method);
        if (m.id === undefined) return;
        queueMicrotask(() => {
          try {
            const result = m.method === 'initialize' ? {} : handler(m.method, m.params);
            lineCb(JSON.stringify({ id: m.id, result }));
          } catch {
            lineCb(JSON.stringify({ id: m.id, error: { code: -32603, message: 'secret me@example.com' } }));
          }
        });
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => {
        state.killed += 1;
        return Promise.resolve();
      },
    };
    return proc;
  };
  return { spawnServer, state };
}

const model = (id: string, efforts: string[], extra: Record<string, unknown> = {}) => ({
  model: id,
  id: `${id}-internal`,
  displayName: id.toUpperCase(),
  supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: 'd' })),
  defaultReasoningEffort: efforts[1] ?? efforts[0],
  ...extra,
});

describe('claudeRegistry', () => {
  it('is documented-only and never claims account access', () => {
    expect(claudeRegistry.length).toBeGreaterThan(0);
    for (const m of claudeRegistry) {
      expect(m).toMatchObject({ provider: 'claude', source: 'documented', access: 'unverified' });
      expect(m.efforts).toEqual({ status: 'unknown' });
      expect(m.modes.ultracode).toBe('unknown');
    }
  });
});

describe('asEffortLevel', () => {
  it('rejects ultracode and malformed names', () => {
    expect(asEffortLevel('xhigh')).toBe('xhigh');
    expect(asEffortLevel('ultracode')).toBeUndefined();
    for (const bad of ['', 'High', 'a b', 1, null, 'x'.repeat(40)]) expect(asEffortLevel(bad)).toBeUndefined();
  });
});

describe('parseCodexModel', () => {
  it('keeps id, name, efforts and default, and drops everything else', () => {
    const parsed = parseCodexModel(model('gpt-a', ['low', 'medium', 'high'], { token: 'sk-secret', description: 'x' }));
    expect(parsed).toEqual({
      provider: 'codex',
      id: 'gpt-a',
      displayName: 'GPT-A',
      source: 'discovered',
      access: 'listed',
      efforts: { status: 'known', supported: ['low', 'medium', 'high'], default: 'medium' },
      modes: { ultracode: 'unknown' },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('handles missing efforts, an ultracode lookalike, and bad entries', () => {
    expect(parseCodexModel(model('m', []))?.efforts).toEqual({ status: 'unknown' });
    const withMode = parseCodexModel(model('m', ['low', 'ultracode']));
    expect(withMode?.efforts).toEqual({ status: 'known', supported: ['low'] });
    expect(parseCodexModel(null)).toBeUndefined();
    expect(parseCodexModel({ model: 5 })).toBeUndefined();
    expect(parseCodexModel({ model: '' })).toBeUndefined();
  });

  it('omits a default that is not among the supported efforts', () => {
    const parsed = parseCodexModel({ ...model('m', ['low', 'high']), defaultReasoningEffort: 'max' });
    expect(parsed?.efforts).toEqual({ status: 'known', supported: ['low', 'high'] });
  });
});

describe('discoverCodexModels', () => {
  it('follows pagination and dedupes models', async () => {
    const pages: Record<string, unknown> = {
      start: { data: [model('a', ['low', 'high']), model('b', ['medium'])], nextCursor: 'p2' },
      p2: { data: [model('b', ['low']), model('c', ['high'])], nextCursor: 'p3' },
      p3: { data: [model('d', ['low'])], nextCursor: null },
    };
    const calls: unknown[] = [];
    const s = server((method, params) => {
      calls.push(params);
      return pages[(params?.['cursor'] as string | undefined) ?? 'start'];
    });
    const result = await discoverCodexModels(s.spawnServer, 2000);
    expect(result.state === 'ok' && result.models.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(calls).toHaveLength(3);
    expect(s.state.methods).toEqual(['initialize', 'initialized', 'model/list', 'model/list', 'model/list']);
    expect(s.state.killed).toBe(1);
  });

  it('stops on a repeated cursor instead of looping forever', async () => {
    const s = server(() => ({ data: [model('a', ['low'])], nextCursor: 'same' }));
    const result = await discoverCodexModels(s.spawnServer, 2000);
    expect(result.state).toBe('ok');
    expect(s.state.methods.filter((m) => m === 'model/list')).toHaveLength(2);
  });

  it('reports a rejected request with a fixed message only', async () => {
    const s = server(() => {
      throw new Error('boom');
    });
    expect(await discoverCodexModels(s.spawnServer, 2000)).toEqual({ state: 'error', error: 'request was rejected' });
    expect(s.state.killed).toBe(1);
  });

  it('times out and maps a missing binary', async () => {
    const silent: AppServerSpawn = () => ({
      send: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    });
    expect(await discoverCodexModels(silent, 20)).toEqual({ state: 'error', error: 'timed out' });
    const missing: AppServerSpawn = () => {
      let exit: (e: { notFound: boolean }) => void = () => undefined;
      return {
        send: () => { queueMicrotask(() => { exit({ notFound: true }); }); },
        onLine: () => undefined,
        onExit: (cb) => (exit = cb),
        kill: () => Promise.resolve(),
      };
    };
    expect(await discoverCodexModels(missing, 1000)).toEqual({ state: 'not-installed' });
  });
});

describe('checkEffort: unknown vs unsupported', () => {
  const codexModel = parseCodexModel(model('gpt-a', ['low', 'medium', 'high'])) as ModelCapability;
  const registry = [...claudeRegistry, codexModel];

  it('supported, with default flag', () => {
    expect(checkEffort(registry, 'codex', 'gpt-a', 'medium')).toEqual({ status: 'supported', isDefault: true });
    expect(checkEffort(registry, 'codex', 'gpt-a', 'low')).toEqual({ status: 'supported', isDefault: false });
  });

  it('unsupported only when the model efforts are known', () => {
    expect(checkEffort(registry, 'codex', 'gpt-a', 'max')).toEqual({
      status: 'unsupported',
      supported: ['low', 'medium', 'high'],
    });
  });

  it('unknown when the model is not listed or efforts were never documented', () => {
    expect(checkEffort(registry, 'codex', 'nope', 'low')).toEqual({ status: 'unknown', reason: 'model-not-listed' });
    expect(checkEffort(registry, 'claude', 'claude-opus-5-5', 'high')).toEqual({
      status: 'unknown',
      reason: 'efforts-not-known',
    });
    expect(checkEffort([], 'codex', 'gpt-a', 'low')).toMatchObject({ status: 'unknown' });
  });

  it('is definitely unsupported for Claude when the effort name is outside the documented levels', () => {
    expect(checkEffort(registry, 'claude', 'claude-opus-5-5', 'minimal')).toEqual({
      status: 'unsupported',
      supported: CLAUDE_EFFORT_LEVELS,
    });
  });

  it('never treats ultracode as an effort', () => {
    expect(checkEffort(registry, 'codex', 'gpt-a', 'ultracode')).toEqual({ status: 'unknown', reason: 'invalid-effort' });
    expect(checkEffort(registry, 'claude', 'claude-opus-5-5', 'ultracode')).toEqual({
      status: 'unknown',
      reason: 'invalid-effort',
    });
  });
});
