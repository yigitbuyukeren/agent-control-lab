import { describe, expect, it } from 'vitest';
import { claudeRegistry, parseCodexModel, type CodexModelsResult, type ModelCapability } from './models.ts';
import { DEFAULT_REQUEST, isDefaultRequest, resolveSelection, type ModelCatalog, type SelectionRequest } from './selection.ts';

const codexModel = (id: string, efforts: string[], def?: string): ModelCapability =>
  parseCodexModel({
    model: id,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    ...(def === undefined ? {} : { defaultReasoningEffort: def }),
  }) as ModelCapability;

const live: CodexModelsResult = {
  state: 'ok',
  models: [codexModel('gpt-a', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium'), codexModel('gpt-b', ['low', 'high'])],
};
const catalog = (codex: CodexModelsResult = live): ModelCatalog => ({ claude: claudeRegistry, codex });
const req = (r: Partial<SelectionRequest>): SelectionRequest => ({ ...DEFAULT_REQUEST, ...r });
const codes = (r: ReturnType<typeof resolveSelection>) => r.issues.map((i) => i.code);

describe('defaults', () => {
  it('keeps provider defaults with no issues and no manual approval', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const s = resolveSelection(provider, DEFAULT_REQUEST, catalog());
      expect(s).toEqual({
        provider,
        model: { kind: 'provider-default' },
        effort: { kind: 'provider-default' },
        mode: 'normal',
        issues: [],
        manualApprovalRequired: false,
        blocked: false,
      });
    }
    expect(isDefaultRequest(DEFAULT_REQUEST)).toBe(true);
    expect(isDefaultRequest(req({ mode: 'ultracode' }))).toBe(false);
  });
});

describe('Codex model + effort against the live registry', () => {
  it('verifies a listed model and treats ultra as a valid Codex effort', () => {
    const s = resolveSelection('codex', req({ model: 'gpt-a', effort: 'ultra' }), catalog());
    expect(s).toMatchObject({
      model: { kind: 'explicit', value: 'gpt-a', verified: true },
      effort: { kind: 'explicit', value: 'ultra', verified: true },
      issues: [],
      manualApprovalRequired: false,
    });
  });

  it('flags a model that discovery did not list, without falling back', () => {
    const s = resolveSelection('codex', req({ model: 'gpt-zzz', effort: 'low' }), catalog());
    expect(codes(s)).toEqual(['model-not-listed']);
    expect(s).toMatchObject({ model: { kind: 'explicit', value: 'gpt-zzz', verified: false }, blocked: true, manualApprovalRequired: true });
  });

  it('flags a definitely unsupported effort for a listed model', () => {
    const s = resolveSelection('codex', req({ model: 'gpt-b', effort: 'ultra' }), catalog());
    expect(s.issues).toEqual([{ code: 'effort-unsupported', blocking: true, effort: 'ultra', supported: ['low', 'high'] }]);
    expect(s.blocked).toBe(true);
  });

  it('keeps discovery failure distinct from model-not-listed', () => {
    for (const [state, reason] of [
      [{ state: 'error', error: 'timed out' }, 'error'],
      [{ state: 'not-installed' }, 'not-installed'],
    ] as const) {
      const s = resolveSelection('codex', req({ model: 'gpt-a', effort: 'high' }), catalog(state));
      expect(codes(s)).toEqual(['model-discovery-failed', 'effort-unverified']);
      expect(codes(s)).not.toContain('model-not-listed');
      expect(s.issues[0]).toMatchObject({ code: 'model-discovery-failed', reason, blocking: false });
      expect(s.issues[1]).toMatchObject({ reason: 'catalog-unavailable' });
      expect(s).toMatchObject({ model: { verified: false }, manualApprovalRequired: true, blocked: false });
    }
  });

  it('does not verify an effort against an assumed default model', () => {
    const s = resolveSelection('codex', req({ effort: 'ultra' }), catalog());
    expect(s.issues).toEqual([{ code: 'effort-unverified', blocking: false, effort: 'ultra', reason: 'default-model-unknown' }]);
    expect(s.model).toEqual({ kind: 'provider-default' });
  });
});

describe('Claude', () => {
  it('never claims account access for an explicit model', () => {
    const documented = resolveSelection('claude', req({ model: 'claude-opus-5-5' }), catalog());
    expect(documented.issues).toEqual([{ code: 'model-access-unverified', blocking: false, model: 'claude-opus-5-5', documented: true }]);
    expect(documented.model).toMatchObject({ verified: false });
    const other = resolveSelection('claude', req({ model: 'claude-made-up' }), catalog());
    expect(other.issues[0]).toMatchObject({ documented: false });
    expect(other.manualApprovalRequired).toBe(true);
  });

  it('cannot verify efforts per model, but rejects names outside the documented levels', () => {
    const ok = resolveSelection('claude', req({ model: 'claude-opus-5-5', effort: 'high' }), catalog());
    expect(codes(ok)).toEqual(['model-access-unverified', 'effort-unverified']);
    expect(ok.issues[1]).toMatchObject({ reason: 'efforts-not-known' });
    const bad = resolveSelection('claude', req({ model: 'claude-opus-5-5', effort: 'ultra' }), catalog());
    expect(bad.issues[1]).toMatchObject({ code: 'effort-unsupported', blocking: true });
    const autoModel = resolveSelection('claude', req({ effort: 'minimal' }), catalog());
    expect(autoModel.issues).toMatchObject([{ code: 'effort-unsupported', blocking: true }]);
    const autoOk = resolveSelection('claude', req({ effort: 'max' }), catalog());
    expect(autoOk.issues).toMatchObject([{ code: 'effort-unverified', reason: 'default-model-unknown' }]);
  });
});

describe('ultracode is a separate, explicit mode', () => {
  it('is never an effort', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const s = resolveSelection(provider, req({ model: provider === 'codex' ? 'gpt-a' : 'claude-opus-5-5', effort: 'ultracode' }), catalog());
      expect(s.issues.some((i) => i.code === 'effort-invalid' && i.blocking)).toBe(true);
    }
  });

  it('requires manual approval when requested, since support is not verified', () => {
    const claude = resolveSelection('claude', req({ mode: 'ultracode' }), catalog());
    expect(claude).toMatchObject({ mode: 'ultracode', manualApprovalRequired: true, blocked: false });
    expect(claude.issues).toEqual([{ code: 'mode-unverified', blocking: false, mode: 'ultracode' }]);
    const normal = resolveSelection('claude', req({ mode: 'normal' }), catalog());
    expect(normal.issues).toEqual([]);
  });

  it('blocks a model known not to support it', () => {
    const custom: ModelCapability = { ...claudeRegistry[0] as ModelCapability, id: 'no-ultracode', modes: { ultracode: 'unsupported' } };
    const s = resolveSelection('claude', req({ model: 'no-ultracode', mode: 'ultracode' }), { claude: [custom], codex: live });
    expect(codes(s)).toContain('mode-unsupported');
    expect(s.blocked).toBe(true);
  });
});

describe('ultracode on Codex is a definite incompatibility', () => {
  it('blocks it for every Codex request shape, without any catalog', () => {
    for (const request of [req({ mode: 'ultracode' }), req({ model: 'gpt-a', mode: 'ultracode' }), req({ model: 'nope', effort: 'ultra', mode: 'ultracode' })]) {
      for (const codex of [live, { state: 'error', error: 'timed out' } as const, { state: 'not-installed' } as const]) {
        const s = resolveSelection('codex', request, catalog(codex));
        expect(s.issues).toContainEqual({ code: 'mode-unsupported', blocking: true, mode: 'ultracode' });
        expect(s).toMatchObject({ blocked: true, manualApprovalRequired: true, mode: 'ultracode' });
      }
    }
  });

  it('does not block normal mode on Codex', () => {
    expect(resolveSelection('codex', req({ model: 'gpt-a' }), catalog()).blocked).toBe(false);
  });
});

describe('provider preservation and purity', () => {
  it('echoes the chosen provider and does not mutate the catalog', () => {
    const frozen = Object.freeze(catalog());
    const before = JSON.stringify(frozen);
    expect(resolveSelection('codex', req({ model: 'gpt-a' }), frozen).provider).toBe('codex');
    expect(resolveSelection('claude', req({ model: 'gpt-a' }), frozen).provider).toBe('claude');
    expect(JSON.stringify(frozen)).toBe(before);
  });
});
