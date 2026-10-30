import { describe, expect, it } from 'vitest';
import { EVIDENCE_CATALOG, type EvidenceCatalog, type EvidenceEntry } from './evidence-catalog.ts';
import { difficultyOf, MAX_EVIDENCE_AGE_DAYS, recommendFromEvidence, type EvidenceInput } from './evidence-router.ts';

const NOW = new Date('2026-11-05T00:00:00Z');
const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  step: 'review', provider: 'codex', difficulty: 'hard', targetEffort: 'high', available: ['gpt-6.1-sol', 'gpt-6.1-terra'], now: NOW, ...over,
});

describe('the shipped catalog', () => {
  it('has a version, sources with https URLs and real dates, and entries that point at a known source', () => {
    expect(EVIDENCE_CATALOG.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const ids = new Set(EVIDENCE_CATALOG.sources.map((s) => s.id));
    expect(ids.size).toBe(EVIDENCE_CATALOG.sources.length);
    for (const s of EVIDENCE_CATALOG.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.published !== undefined) expect(s.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const e of EVIDENCE_CATALOG.entries) {
      expect(ids.has(e.sourceId)).toBe(true);
      expect(e.benchmark).not.toBe('');
      expect(e.benchmarkVersion).not.toBe('');
      expect(e.effort).not.toBe('');
    }
  });

  it('keeps user reports at low confidence and without a score, and never stores prices or quota', () => {
    const community = new Set(EVIDENCE_CATALOG.sources.filter((s) => s.kind === 'community').map((s) => s.id));
    const reports = EVIDENCE_CATALOG.entries.filter((e) => community.has(e.sourceId));
    expect(reports.length).toBeGreaterThan(0);
    for (const e of reports) {
      expect(e.confidence).toBe('low');
      expect(e.score).toBeUndefined();
    }
    expect(JSON.stringify(EVIDENCE_CATALOG)).not.toMatch(/"price|"quota|"cost/i);
  });

  it('puts only like with like in one group: one benchmark, version, unit and fit per group', () => {
    const groups = new Map<string, EvidenceEntry[]>();
    for (const e of EVIDENCE_CATALOG.entries) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
    for (const [, list] of groups) {
      if (list[0]?.group === 'anthropic-sonnet-5-5-launch') continue; // two benchmarks from one page: the router splits by benchmark
      expect(new Set(list.map((e) => `${e.benchmark}|${e.benchmarkVersion}|${e.metric}|${e.fit}`)).size).toBe(1);
    }
  });
});

describe('recommendFromEvidence with the shipped catalog', () => {
  it('recommends the Codex model that leads an independent same-version, same-effort comparison, with sources', () => {
    const d = recommendFromEvidence(base());
    expect(d.model).toBe('gpt-6.1-sol');
    const text = d.evidence.join('\n');
    expect(text).toContain('https://artificialanalysis.ai/models/gpt-6-1-sol');
    expect(text).toContain('Artificial Analysis Intelligence Index v5.0, effort max, independent (confidence high)');
    expect(text).toContain('gpt-6.1-sol leads gpt-6.1-terra by 4');
    expect(text).toContain('read 2026-10-30');
    expect(text).toContain('prices are not used');
  });

  it('never compares different benchmarks: coding work finds no comparable Codex pair', () => {
    const d = recommendFromEvidence(base({ step: 'implement', available: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol'] }));
    expect(d.model).toBeUndefined();
    expect(d.note).toContain('provider default kept');
    expect(d.evidence.join('\n')).toContain('unspecified');
  });

  it('keeps the default for easy tasks and when the target effort is above what was measured', () => {
    expect(recommendFromEvidence(base({ difficulty: 'easy' })).model).toBeUndefined();
    expect(recommendFromEvidence(base({ targetEffort: undefined })).note).toContain('target effort is unknown');
    expect(recommendFromEvidence(base({ targetEffort: 'minimal' })).model).toBe('gpt-6.1-sol');
  });

  it('uses only models the step can use now', () => {
    expect(recommendFromEvidence(base({ available: ['gpt-6.1-sol'] })).model).toBeUndefined();
    expect(recommendFromEvidence(base({ available: [] })).model).toBeUndefined();
  });

  it('only advises for Claude: access is never assumed, and the lead is shown', () => {
    const d = recommendFromEvidence(base({ step: 'plan', provider: 'claude', available: ['claude-opus-5-5', 'claude-sonnet-5-5'] }));
    expect(d.model).toBeUndefined();
    expect(d.advisoryModel).toBe('claude-opus-5-5');
    expect(d.note).toContain('cannot be shown to be accessible');
    expect(d.evidence.join('\n')).toContain('claude access: UNKNOWN');
  });

  it('ignores stale evidence', () => {
    const late = new Date(Date.parse('2026-10-30T00:00:00Z') + (MAX_EVIDENCE_AGE_DAYS + 1) * 86_400_000);
    const d = recommendFromEvidence(base({ now: late }));
    expect(d.model).toBeUndefined();
    expect(d.evidence.join('\n')).toContain('older than');
  });
});

describe('recommendFromEvidence rules, with synthetic catalogs', () => {
  const src = (id: string, kind: 'independent' | 'official-vendor' | 'community') => ({ id, url: `https://example.test/${id}`, publisher: id, kind, published: '2026-10-01', retrieved: '2026-10-30' });
  const e = (over: Partial<EvidenceEntry>): EvidenceEntry => ({
    sourceId: 'a', group: 'g', provider: 'codex', model: 'm1', variant: 'M1', benchmark: 'B', benchmarkVersion: '1', fit: 'reasoning', metric: 'percent', score: 50, effort: 'high', confidence: 'medium', ...over,
  });
  const cat = (entries: EvidenceEntry[], kind: 'independent' | 'official-vendor' = 'official-vendor'): EvidenceCatalog => ({
    version: 't', sources: [src('a', kind), src('b', 'community'), src('c', 'official-vendor')], entries,
  });
  const run = (c: EvidenceCatalog) => recommendFromEvidence(base({ catalog: c, available: ['m1', 'm2'] }));

  it('needs independent production or a second comparison, not one vendor table', () => {
    const one = cat([e({ model: 'm1', score: 70 }), e({ model: 'm2', score: 60 })]);
    expect(run(one).model).toBeUndefined();
    expect(run(one).note).toContain('independent comparison or a second one');
    const independent = cat([e({ model: 'm1', score: 70, confidence: 'high' }), e({ model: 'm2', score: 60, confidence: 'high' })], 'independent');
    expect(run(independent).model).toBe('m1');
    const two = cat([e({ model: 'm1', score: 70 }), e({ model: 'm2', score: 60 }), e({ model: 'm1', score: 40, benchmark: 'B2', sourceId: 'c' }), e({ model: 'm2', score: 30, benchmark: 'B2', sourceId: 'c' })]);
    expect(run(two).model).toBe('m1');
  });

  it('treats a lead below the margin as a tie and conflicting comparisons as no decision', () => {
    expect(run(cat([e({ model: 'm1', score: 62, confidence: 'high' }), e({ model: 'm2', score: 60, confidence: 'high' })], 'independent')).note).toContain('provider default kept');
    const conflict = cat([e({ model: 'm1', score: 70 }), e({ model: 'm2', score: 60 }), e({ model: 'm1', score: 30, benchmark: 'B2' }), e({ model: 'm2', score: 50, benchmark: 'B2' })]);
    expect(run(conflict).note).toContain('disagree');
  });

  it('does not mix effort settings, versions or units', () => {
    const mixed = cat([e({ model: 'm1', score: 90, confidence: 'high', effort: 'max' }), e({ model: 'm2', score: 60, confidence: 'high', effort: 'high' })], 'independent');
    expect(run(mixed).model).toBeUndefined();
    const versions = cat([e({ model: 'm1', score: 90, confidence: 'high', benchmarkVersion: '2' }), e({ model: 'm2', score: 60, confidence: 'high', benchmarkVersion: '1' })], 'independent');
    expect(run(versions).model).toBeUndefined();
    const units = cat([e({ model: 'm1', score: 90, confidence: 'high', metric: 'index-points' }), e({ model: 'm2', score: 60, confidence: 'high' })], 'independent');
    expect(run(units).model).toBeUndefined();
  });

  it('shows user reports as low-confidence notes and never lets them decide or override', () => {
    const reports = cat([
      e({ model: 'm1', score: 70, confidence: 'high' }), e({ model: 'm2', score: 60, confidence: 'high' }),
      e({ model: 'm2', score: 99, confidence: 'low', sourceId: 'b', group: 'forum' }), e({ model: 'm1', score: 1, confidence: 'medium', sourceId: 'b', group: 'forum2' }),
    ], 'independent');
    const d = run(reports);
    expect(d.model).toBe('m1');
    expect(d.evidence.join('\n')).toContain('supporting, low confidence, not used');
    const only = cat([e({ model: 'm2', score: 99, confidence: 'low', sourceId: 'b' }), e({ model: 'm1', score: 1, confidence: 'low', sourceId: 'b' })]);
    expect(run(only).model).toBeUndefined();
  });

  it('classifies difficulty from size and sensitivity', () => {
    expect(difficultyOf('small', 'general')).toBe('easy');
    expect(difficultyOf('small', 'sensitive')).toBe('hard');
    expect(difficultyOf('large', 'general')).toBe('hard');
    expect(difficultyOf('normal', 'general')).toBe('medium');
  });
});
