/**
 * Versioned evidence about models, taken from published benchmark results. It is data, not a ranking: every entry
 * keeps where it came from, when, which benchmark and version, which effort setting and how far to trust it.
 *
 * Rules the router applies to it (see `evidence-router.ts`):
 * - scores are only compared inside one `group` (same evaluator, benchmark, benchmark version, unit) AND the same
 *   effort setting; a different benchmark, version, unit or effort is never compared;
 * - `official-vendor` results are the vendor's own numbers (confidence medium), `independent` ones come from an
 *   evaluator that ran the models under one method (confidence high), `community` ones are user reports (confidence
 *   low): they are shown as supporting notes and never decide anything;
 * - API prices are not recorded here on purpose: a price per token says nothing about subscription quota;
 * - a model listed here is not thereby accessible to the user: access is checked separately and never assumed.
 *
 * Maintenance: add entries from a source you opened, with its URL and the date you read it; keep the numbers exactly as
 * the source states them and write `unspecified` for an effort the source does not state.
 */
export const EVIDENCE_CATALOG_VERSION = '2026-10-30.1';

export type EvidenceKind = 'official-vendor' | 'independent' | 'community';
export type Confidence = 'high' | 'medium' | 'low';
/** What kind of work a benchmark says something about. */
export type TaskFit = 'reasoning' | 'agentic-coding';
export type EvidenceMetric = 'index-points' | 'percent';

export interface EvidenceSource {
  readonly id: string;
  readonly url: string;
  readonly publisher: string;
  readonly kind: EvidenceKind;
  /** Date the source says it was published or the model released (`YYYY-MM-DD`), when it states one. */
  readonly published?: string;
  /** Date this catalog entry was read from the source (`YYYY-MM-DD`). */
  readonly retrieved: string;
  readonly note?: string;
}

export interface EvidenceEntry {
  readonly sourceId: string;
  /** Comparison group: entries are comparable only within one group. */
  readonly group: string;
  readonly provider: 'claude' | 'codex';
  /** Model id as the provider's API/CLI uses it. */
  readonly model: string;
  /** Model name and variant exactly as the source labels it. */
  readonly variant: string;
  readonly benchmark: string;
  readonly benchmarkVersion: string;
  readonly fit: TaskFit;
  readonly metric: EvidenceMetric;
  /** Absent for a report that has no numeric score. */
  readonly score?: number;
  /** Effort setting the score was measured at, or `unspecified` when the source does not say. */
  readonly effort: string;
  readonly confidence: Confidence;
  readonly note?: string;
}

export interface EvidenceCatalog {
  readonly version: string;
  readonly sources: readonly EvidenceSource[];
  readonly entries: readonly EvidenceEntry[];
}

const FETCH_NOTE = 'read on 2026-10-30 through a text-extraction tool; check the figure against the URL before relying on it';
const AA_NOTE = 'Artificial Analysis Intelligence Index v5.0; the page shows no evaluation date';

const sources: readonly EvidenceSource[] = [
  { id: 'aa-opus-5-5', url: 'https://artificialanalysis.ai/models/claude-opus-5-5', publisher: 'Artificial Analysis', kind: 'independent', published: '2026-09-22', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-sonnet-5-5', url: 'https://artificialanalysis.ai/models/claude-sonnet-5-5', publisher: 'Artificial Analysis', kind: 'independent', published: '2026-09-28', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-gpt-6-1-sol', url: 'https://artificialanalysis.ai/models/gpt-6-1-sol', publisher: 'Artificial Analysis', kind: 'independent', published: '2026-09-29', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-gpt-6-1-terra', url: 'https://artificialanalysis.ai/models/gpt-6-1-terra', publisher: 'Artificial Analysis', kind: 'independent', published: '2026-10-26', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  {
    id: 'anthropic-sonnet-5-5',
    url: 'https://www.anthropic.com/claude-sonnet-5-5',
    publisher: 'Anthropic',
    kind: 'official-vendor',
    published: '2026-09-28',
    retrieved: '2026-10-30',
    note: `launch page, the vendor's own results and harness; ${FETCH_NOTE}`,
  },
  {
    id: 'openai-forum-terra',
    url: 'https://community.openai.com/t/gpt-6-1-terra-delivering-fast-and-capable-computer-use-at-a-lower-price/1409900',
    publisher: 'OpenAI Developer Community (a forum user)',
    kind: 'community',
    published: '2026-10-26',
    retrieved: '2026-10-30',
    note: FETCH_NOTE,
  },
];

const aa = (sourceId: string, model: string, variant: string, score: number, provider: 'claude' | 'codex'): EvidenceEntry => ({
  sourceId,
  group: 'artificial-analysis-intelligence-index-v5.0',
  provider,
  model,
  variant,
  benchmark: 'Artificial Analysis Intelligence Index',
  benchmarkVersion: 'v5.0',
  fit: 'reasoning',
  metric: 'index-points',
  score,
  effort: 'max',
  confidence: 'high',
  note: 'a general intelligence index, not a coding benchmark',
});

const launch = (model: string, variant: string, benchmark: string, benchmarkVersion: string, score: number, effort: string, provider: 'claude' | 'codex', note?: string): EvidenceEntry => ({
  sourceId: 'anthropic-sonnet-5-5',
  group: 'anthropic-sonnet-5-5-launch',
  provider,
  model,
  variant,
  benchmark,
  benchmarkVersion,
  fit: 'agentic-coding',
  metric: 'percent',
  score,
  effort,
  confidence: 'medium',
  ...(note === undefined ? {} : { note }),
});

const entries: readonly EvidenceEntry[] = [
  aa('aa-opus-5-5', 'claude-opus-5-5', 'Claude Opus 5.5 (Max, Default Fallback)', 58, 'claude'),
  aa('aa-sonnet-5-5', 'claude-sonnet-5-5', 'Claude Sonnet 5.5 (max with fallback)', 54, 'claude'),
  aa('aa-gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol (Max)', 55, 'codex'),
  aa('aa-gpt-6-1-terra', 'gpt-6.1-terra', 'GPT-6.1 Terra (max)', 51, 'codex'),
  launch('claude-sonnet-5-5', 'Sonnet 5.5', 'Terminal-Bench', '4.0', 70.6, 'unspecified', 'claude', 'effort not stated; the page notes Sonnet 5.5 scores lower at max than at xhigh on another benchmark'),
  launch('claude-opus-5-5', 'Opus 5.5', 'Terminal-Bench', '4.0', 66.4, 'xhigh', 'claude', "the page says this is Opus 5.5's highest score, so it is a best case"),
  launch('claude-sonnet-5-5', 'Sonnet 5.5', 'FrontierCode (Main set)', '1.1', 46.2, 'max', 'claude'),
  launch('claude-opus-5-5', 'Opus 5.5', 'FrontierCode (Main set)', '1.1', 54.4, 'unspecified', 'claude'),
  launch('gpt-6-sol', 'GPT-6 Sol', 'FrontierCode (Main set)', '1.1', 49.3, 'unspecified', 'codex', 'a different model from GPT-6.1 Sol'),
  {
    sourceId: 'openai-forum-terra',
    group: 'community-digbench',
    provider: 'codex',
    model: 'gpt-6.1-terra',
    variant: 'GPT-6.1 Terra',
    benchmark: 'DigBench (a forum user\'s own tasks)',
    benchmarkVersion: 'not stated',
    fit: 'agentic-coding',
    metric: 'percent',
    effort: 'high',
    confidence: 'low',
    note: 'no numeric score: one user reported P-1 won twice and P-2 lost twice at high effort; the task changes on every run',
  },
];

export const EVIDENCE_CATALOG: EvidenceCatalog = { version: EVIDENCE_CATALOG_VERSION, sources, entries };
