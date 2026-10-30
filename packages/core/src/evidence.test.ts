import { describe, expect, it } from 'vitest';
import { EVIDENCE_CATALOG, type EvidenceCatalog, type EvidenceClaim, type EvidenceEntry, type EvidenceSource, type TaskFit } from './evidence-catalog.ts';
import { difficultyOf, MAX_EVIDENCE_AGE_DAYS, recommendFromEvidence, type EvidenceInput } from './evidence-router.ts';

const NOW = new Date('2026-11-05T00:00:00Z');
const MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol'];
const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  step: 'implement', provider: 'codex', difficulty: 'hard', targetEffort: 'high', available: MODELS, now: NOW, ...over,
});

describe('the shipped catalog', () => {
  it('has a version, https sources with real dates, and entries and claims that point at a known source', () => {
    expect(EVIDENCE_CATALOG.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const ids = new Set(EVIDENCE_CATALOG.sources.map((s) => s.id));
    expect(ids.size).toBe(EVIDENCE_CATALOG.sources.length);
    for (const s of EVIDENCE_CATALOG.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const d of [s.published, s.evaluated, s.modelReleased]) if (d !== undefined) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const e of [...EVIDENCE_CATALOG.entries, ...EVIDENCE_CATALOG.claims]) {
      expect(ids.has(e.sourceId)).toBe(true);
      expect(e.benchmark).not.toBe('');
      expect(e.harness).not.toBe('');
    }
  });

  it('contains the two official OpenAI pages with only what their text states', () => {
    const urls = EVIDENCE_CATALOG.sources.map((s) => s.url);
    expect(urls).toContain('https://openai.com/index/introducing-gpt-6-1-sol/');
    expect(urls).toContain('https://openai.com/index/introducing-gpt-6-1-terra/');
    const terra = EVIDENCE_CATALOG.entries.find((e) => e.sourceId === 'openai-gpt-6-1-terra');
    expect(terra).toMatchObject({ model: 'gpt-6.1-terra', benchmark: 'Terminal-Bench', benchmarkVersion: '4.0', score: 50.3, effort: 'highest' });
    const sol = EVIDENCE_CATALOG.claims.filter((c) => c.sourceId === 'openai-gpt-6-1-sol');
    expect(sol.map((c) => [c.benchmark.split(' ')[0], c.benchmarkVersion, c.delta, c.effort])).toEqual([
      ['DeepSWE', '1.1', 6.4, 'unspecified'],
      ['AutomationBench', '1.0.6', 4.8, 'medium'],
      ['OSWorld', '2.0', 7, 'highest'],
    ]);
    for (const id of ['openai-gpt-6-1-sol', 'openai-gpt-6-1-terra']) {
      const s = EVIDENCE_CATALOG.sources.find((x) => x.id === id);
      expect(s?.published).toBeUndefined();
      expect(s?.evaluated).toBeUndefined();
      expect(s?.note).toContain('states no publication or evaluation date');
    }
  });

  it('keeps user reports at low confidence without a score, and never stores prices or quota', () => {
    const community = new Set(EVIDENCE_CATALOG.sources.filter((s) => s.kind === 'community').map((s) => s.id));
    const reports = EVIDENCE_CATALOG.entries.filter((e) => community.has(e.sourceId));
    expect(reports.length).toBeGreaterThan(0);
    for (const e of reports) {
      expect(e.confidence).toBe('low');
      expect(e.score).toBeUndefined();
    }
    expect(JSON.stringify(EVIDENCE_CATALOG)).not.toMatch(/"price|"quota|"cost/i);
  });

  it('marks the general intelligence index as such and no general index as coding or review evidence', () => {
    const index = EVIDENCE_CATALOG.entries.filter((e) => e.benchmark.includes('Intelligence Index'));
    expect(index.length).toBe(4);
    for (const e of index) expect(e.fit).toBe('general-intelligence');
  });
});

describe('recommendFromEvidence with the shipped catalog: nothing task-fit and equivalent exists today', () => {
  it('keeps the default for every step, provider and effort', () => {
    for (const step of ['plan', 'implement', 'review'] as const) {
      for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'highest']) {
        for (const [provider, available] of [['codex', MODELS], ['claude', ['claude-opus-5-5', 'claude-sonnet-5-5']]] as const) {
          const d = recommendFromEvidence(base({ step, provider, targetEffort: effort, available }));
          expect(d.model).toBeUndefined();
          expect(d.advisoryModel).toBeUndefined();
          expect(d.note).toContain('provider default kept');
        }
      }
    }
  });

  it('does not count the general index as review or coding evidence, and says what it is', () => {
    const review = recommendFromEvidence(base({ step: 'review', targetEffort: 'max' })).evidence.join('\n');
    expect(review).toContain('context only, not evidence for review work: Artificial Analysis Intelligence Index v5.0 (general-intelligence): gpt-6.1-sol 55 points, gpt-6.1-terra 51 points');
    const coding = recommendFromEvidence(base({ step: 'implement', targetEffort: 'max' })).evidence.join('\n');
    expect(coding).toContain('context only, not evidence for implement work: Artificial Analysis Intelligence Index');
    expect(coding).toContain('AutomationBench 1.0.6 (workflow-automation)');
    expect(coding).toContain('OSWorld (offline dataset v2026.08.08, partial reward) 2.0 (computer-use)');
  });

  it('refuses coding claims whose effort is unnamed or different, and a single-model result', () => {
    const text = recommendFromEvidence(base({ step: 'implement', targetEffort: 'high' })).evidence.join('\n');
    expect(text).toContain('effort not stated, so it cannot be matched to this step): gpt-6.1-sol ahead of gpt-6-sol by 6.4 points: DeepSWE 1.1');
    expect(text).toContain('measured at effort highest, but this step runs at high; results at different efforts are not equivalent): gpt-6.1-terra 50.3%');
    expect(text).toContain('supporting, low confidence, not used for the decision');
  });

  it('states that the evaluation date is unknown, separately from the date the page was read', () => {
    const text = recommendFromEvidence(base({ step: 'implement', targetEffort: 'high' })).evidence.join('\n');
    expect(text).toContain('evaluation date not stated by the source');
    expect(text).toContain('page read 2026-10-30');
    expect(text).toContain('re-reading a page does not refresh a benchmark');
    expect(text).toContain('the source states no evaluation, publication or release date, so freshness is unknown');
  });

  it('keeps the default for easy tasks and an unknown target effort', () => {
    expect(recommendFromEvidence(base({ difficulty: 'easy' })).note).toContain('easy task');
    expect(recommendFromEvidence(base({ targetEffort: undefined })).note).toContain('effort this step will run at is unknown');
  });
});

describe('recommendFromEvidence rules, with synthetic catalogs', () => {
  const src = (id: string, kind: EvidenceSource['kind'], over: Partial<EvidenceSource> & { undated?: boolean } = {}): EvidenceSource => {
    const { undated, ...rest } = over;
    return { id, url: `https://example.test/${id}`, publisher: id, kind, retrieved: '2026-11-04', ...(undated === true ? {} : { published: '2026-10-01' }), ...rest };
  };
  const e = (over: Partial<EvidenceEntry>): EvidenceEntry => ({
    sourceId: 'a', group: 'g', provider: 'codex', model: 'm1', variant: 'M1', benchmark: 'B', benchmarkVersion: '1', fit: 'agentic-coding', metric: 'percent', score: 50, effort: 'high', harness: 'h', confidence: 'high', ...over,
  });
  const claim = (over: Partial<EvidenceClaim>): EvidenceClaim => ({
    sourceId: 'v', group: 'g2', provider: 'codex', model: 'm1', versus: 'm2', benchmark: 'C', benchmarkVersion: '1', fit: 'agentic-coding', delta: 8, effort: 'high', versusEffort: 'high', harness: 'h', confidence: 'medium', ...over,
  });
  const cat = (entries: EvidenceEntry[], claims: EvidenceClaim[] = [], sources: EvidenceSource[] = []): EvidenceCatalog => ({
    version: 't', sources: [src('a', 'independent'), src('v', 'official-vendor'), src('b', 'community'), ...sources], entries, claims,
  });
  const run = (c: EvidenceCatalog, over: Partial<EvidenceInput> = {}) => recommendFromEvidence(base({ catalog: c, available: ['m1', 'm2'], ...over }));
  const pair = (over: Partial<EvidenceEntry> = {}) => [e({ model: 'm1', score: 70, ...over }), e({ model: 'm2', score: 60, ...over })];

  it('recommends a model that leads an independent, task-fit comparison at exactly the step\'s effort, with its effort', () => {
    const d = run(cat(pair()));
    expect(d.model).toBe('m1');
    expect(d.evidenceEffort).toBe('high');
    expect(d.evidence.join('\n')).toContain('source https://example.test/a');
  });

  it('does not carry a max result over to a high or medium run, and matches only the same effort', () => {
    const maxOnly = cat(pair({ effort: 'max' }));
    expect(run(maxOnly, { targetEffort: 'high' }).model).toBeUndefined();
    expect(run(maxOnly, { targetEffort: 'medium' }).model).toBeUndefined();
    expect(run(maxOnly, { targetEffort: 'high' }).evidence.join('\n')).toContain('results at different efforts are not equivalent');
    expect(run(maxOnly, { targetEffort: 'max' }).model).toBe('m1');
    const mixed = cat([e({ model: 'm1', score: 90, effort: 'max' }), e({ model: 'm2', score: 60, effort: 'high' })]);
    expect(run(mixed, { targetEffort: 'high' }).model).toBeUndefined();
    expect(run(mixed, { targetEffort: 'max' }).model).toBeUndefined();
  });

  it('counts only benchmarks that measure the step\'s kind of work', () => {
    const wrong: TaskFit[] = ['general-intelligence', 'workflow-automation', 'computer-use', 'scientific-agents', 'planning'];
    for (const fit of wrong) expect(run(cat(pair({ fit })), { step: 'implement' }).model).toBeUndefined();
    expect(run(cat(pair({ fit: 'code-review' })), { step: 'review' }).model).toBe('m1');
    expect(run(cat(pair({ fit: 'code-review' })), { step: 'implement' }).model).toBeUndefined();
    expect(run(cat(pair({ fit: 'agentic-coding' })), { step: 'review' }).model).toBeUndefined();
    expect(run(cat(pair({ fit: 'planning' })), { step: 'plan' }).model).toBe('m1');
  });

  it('does not equate different harnesses, versions or units, and ignores an unstated harness', () => {
    expect(run(cat([e({ model: 'm1', score: 90, harness: 'x' }), e({ model: 'm2', score: 60, harness: 'y' })])).model).toBeUndefined();
    expect(run(cat([e({ model: 'm1', score: 90, benchmarkVersion: '2' }), e({ model: 'm2', score: 60 })])).model).toBeUndefined();
    expect(run(cat([e({ model: 'm1', score: 90, metric: 'index-points' }), e({ model: 'm2', score: 60 })])).model).toBeUndefined();
    const unstated = run(cat(pair({ harness: 'unspecified' })));
    expect(unstated.model).toBeUndefined();
    expect(unstated.evidence.join('\n')).toContain('harness not stated');
  });

  it('counts freshness from the source\'s own dates, never from the day the page was read', () => {
    const stale = cat(pair(), [], [src('a', 'independent', { undated: true, modelReleased: '2026-03-01' })]);
    const old = { ...stale, sources: stale.sources.filter((s, i) => !(s.id === 'a' && i === 0)) };
    const d = run(old);
    expect(d.model).toBeUndefined();
    expect(d.evidence.join('\n')).toContain('model release date 2026-03-01 is older than 120 days');
    const undated = cat(pair(), [], [src('a', 'independent', { undated: true })]);
    const u = run({ ...undated, sources: undated.sources.filter((s, i) => !(s.id === 'a' && i === 0)) });
    expect(u.model).toBeUndefined();
    expect(u.evidence.join('\n')).toContain('freshness is unknown');
    const fresh = new Date(Date.parse('2026-10-01T00:00:00Z') + (MAX_EVIDENCE_AGE_DAYS - 1) * 86_400_000);
    expect(run(cat(pair()), { now: fresh }).model).toBe('m1');
    expect(run(cat(pair()), { now: new Date(fresh.getTime() + 3 * 86_400_000) }).model).toBeUndefined();
  });

  it('says plainly when the evaluation date is unknown', () => {
    expect(run(cat(pair())).evidence.join('\n')).toContain('evaluation date not stated by the source');
    const dated = cat(pair(), [], [src('a', 'independent', { evaluated: '2026-10-15' })]);
    expect(run({ ...dated, sources: dated.sources.filter((s, i) => !(s.id === 'a' && i === 0)) }).evidence.join('\n')).toContain('evaluated 2026-10-15');
  });

  it('needs independent production or a second comparison, and a clear lead; conflicts keep the default', () => {
    const vendor = cat(pair({ sourceId: 'v', confidence: 'medium' }));
    expect(run(vendor).model).toBeUndefined();
    expect(run(vendor).note).toContain('independent comparison or a second one');
    const twice = cat([...pair({ sourceId: 'v', confidence: 'medium' }), ...pair({ sourceId: 'v', confidence: 'medium', benchmark: 'B2' })]);
    expect(run(twice).model).toBe('m1');
    expect(run(cat([e({ model: 'm1', score: 62 }), e({ model: 'm2', score: 60 })])).model).toBeUndefined();
    const conflict = cat([...pair({ sourceId: 'v', confidence: 'medium' }), e({ model: 'm1', score: 30, benchmark: 'B2', sourceId: 'v', confidence: 'medium' }), e({ model: 'm2', score: 50, benchmark: 'B2', sourceId: 'v', confidence: 'medium' })]);
    expect(run(conflict).note).toContain('disagree');
  });

  it('uses a stated difference only at one named, equal effort and with a clear margin', () => {
    expect(run(cat([], [claim({}), claim({ benchmark: 'D' })])).model).toBe('m1');
    expect(run(cat([], [claim({})])).model).toBeUndefined();
    expect(run(cat([], [claim({ delta: 4.8 }), claim({ delta: 4.8, benchmark: 'D' })])).model).toBeUndefined();
    expect(run(cat([], [claim({ effort: 'unspecified', versusEffort: 'unspecified' }), claim({ benchmark: 'D', effort: 'unspecified', versusEffort: 'unspecified' })])).model).toBeUndefined();
    expect(run(cat([], [claim({ versusEffort: 'low' }), claim({ benchmark: 'D', versusEffort: 'low' })])).model).toBeUndefined();
  });

  it('shows user reports as low-confidence notes and never lets them decide or override', () => {
    const reports = cat([...pair(), e({ model: 'm2', score: 99, confidence: 'low', sourceId: 'b', group: 'forum' })]);
    const d = run(reports);
    expect(d.model).toBe('m1');
    expect(d.evidence.join('\n')).toContain('supporting, low confidence, not used');
    expect(run(cat([e({ model: 'm2', score: 99, confidence: 'low', sourceId: 'b' }), e({ model: 'm1', score: 1, confidence: 'low', sourceId: 'b' })])).model).toBeUndefined();
  });

  it('only advises for Claude and uses only models the step can use now', () => {
    const c = cat(pair({ provider: 'claude', fit: 'planning' }));
    const d = run(c, { step: 'plan', provider: 'claude' });
    expect(d.model).toBeUndefined();
    expect(d.advisoryModel).toBe('m1');
    expect(d.evidence.join('\n')).toContain('claude access: UNKNOWN');
    expect(run(cat(pair()), { available: ['m1'] }).model).toBeUndefined();
  });

  it('classifies difficulty from size and sensitivity', () => {
    expect(difficultyOf('small', 'general')).toBe('easy');
    expect(difficultyOf('small', 'sensitive')).toBe('hard');
    expect(difficultyOf('large', 'general')).toBe('hard');
    expect(difficultyOf('normal', 'general')).toBe('medium');
  });
});
