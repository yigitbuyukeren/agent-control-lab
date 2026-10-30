import { describe, expect, it } from 'vitest';
import { parseDryRun, parseModels, parseQuota, parseProviderLines, mergeLogin, evidenceKind } from './gui-model.ts';

const DRY = `orchestrate plan (dry run, no agent started)
  workflow: plan-review
  policy: balanced; manual settings win
  step 1/2 plan [claude]: tool-less, no session persistence, subscription login: would refuse: proxy variables are set
      model: provider-default; reason: guided routing: provider default kept
      routing basis: no sufficient basis, provider default; uncertainty: high
      evidence: benchmark evidence (strict): provider default kept
      evidence: intent-based reading (vendor documentation, not measurements): focused-work
      evidence: claude access: UNKNOWN
      effort: provider-default; reason: policy balanced: nothing verified
      verification: nothing pinned, nothing to verify
      not forwarded: ANTHROPIC_BASE_URL
  step 2/2 review [codex]: read-only sandbox, git repo, subscription login: would run
      model: gpt-6-luna (verified); reason: guided routing: documented for focused-work
      routing basis: documented intent of the model (vendor documentation), not a measurement; uncertainty: medium
      effort: low (verified); reason: policy balanced: low
      verification: verified
  requires: --confirm
  verdict: would refuse
`;

describe('parseDryRun', () => {
  const view = parseDryRun(DRY);
  it('reads steps, settings, basis, uncertainty and verdicts', () => {
    expect(view.verdict).toBe('would-refuse');
    expect(view.meta['workflow']).toBe('plan-review');
    expect(view.meta['requires']).toBe('--confirm');
    const [plan, review] = view.steps;
    expect(plan?.verdict).toBe('would-refuse');
    expect(plan?.refusal).toBe('proxy variables are set');
    expect(plan?.model?.value).toBe('provider-default');
    expect(plan?.uncertainty).toBe('high');
    expect(plan?.verification).toContain('nothing to verify');
    expect(plan?.notes).toEqual(['not forwarded: ANTHROPIC_BASE_URL']);
    expect(plan?.mode).toBe('tool-less, no session persistence');
    expect(review?.verdict).toBe('would-run');
    expect(review?.model?.value).toBe('gpt-6-luna (verified)');
    expect(review?.effort?.value).toBe('low (verified)');
    expect(review?.uncertainty).toBe('medium');
  });
  it('keeps benchmark evidence apart from documentation-based reading', () => {
    expect(view.steps[0]?.evidence.map((e) => e.kind)).toEqual(['benchmark', 'documentation', 'access']);
    expect(evidenceKind('evidence catalog 1: x')).toBe('catalog');
    expect(evidenceKind('something else')).toBe('other');
  });
  it('invents nothing from unrecognised text', () => {
    const v = parseDryRun('nonsense\n');
    expect(v.steps).toEqual([]);
    expect(v.verdict).toBe('unknown');
  });
});

describe('status parsers', () => {
  it('reads providers, login, quota windows and model efforts', () => {
    const merged = mergeLogin(parseProviderLines('Claude Code  installed 2.1\nCodex        installed 0.1\n'), 'Claude Code  logged in (subscription, pro)\n');
    expect(merged).toEqual([
      { id: 'claude', name: 'Claude Code', install: 'installed 2.1', login: 'logged in (subscription, pro)' },
      { id: 'codex', name: 'Codex', install: 'installed 0.1' },
    ]);
    expect(parseQuota('Codex plan: plus\n  7d window (secondary): 16% used, resets 2026-11-05T17:46:09.000Z\n')).toEqual([
      { provider: 'codex', plan: 'plus', windows: [{ label: '7d window (secondary)', usedPercent: 16, resets: '2026-11-05T17:46:09.000Z' }] },
    ]);
    expect(parseQuota('no quota\n')).toEqual([]);
    const groups = parseModels('Claude Code (documented; account access not verified)\n  claude-a (A): efforts unknown (documented levels: low, high)\nCodex (discovered via app-server model/list)\n  gpt-a (GA): efforts low, high, ultra, default low; ultracode mode unsupported\nnote: x\n');
    expect(groups[0]?.models[0]).toMatchObject({ id: 'claude-a', efforts: ['low', 'high'], effortsVerified: false });
    expect(groups[1]?.models[0]).toMatchObject({ id: 'gpt-a', efforts: ['low', 'high', 'ultra'], effortsVerified: true, defaultEffort: 'low' });
  });
});
