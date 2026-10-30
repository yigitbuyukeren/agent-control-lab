/**
 * Versioned evidence about models, taken from published benchmark results. It is data, not a ranking: every entry
 * keeps where it came from, which benchmark and version, the effort the result was measured at, the harness, and how
 * far to trust it. Only what a source states is recorded; a value that could not be read from the source is not added.
 *
 * Rules the router applies to it (see `evidence-router.ts`):
 * - scores are compared only inside one `group` with the same benchmark, benchmark version, unit, harness and effort
 *   setting, and the effort must also be the effort the step will run at; `unspecified` for effort or harness means the
 *   source does not say, and such a result is never compared;
 * - a benchmark only counts for the kind of work it measures (`TaskFit`): a general intelligence index is not
 *   evidence about coding or code review;
 * - `official-vendor` results are the vendor's own numbers (confidence medium), `independent` ones come from an evaluator
 *   that ran the models under one method (confidence high), `community` ones are user reports (confidence low): they are
 *   shown as supporting notes and never decide anything;
 * - freshness is counted from the date of the evaluation, else of the publication, else of the model's release as the
 *   source states it. The date this catalog read a page is NOT such a date: reading a page again does not refresh a
 *   benchmark. A result without any of these dates is never used for a decision;
 * - API prices are not recorded on purpose: a price per token says nothing about subscription quota;
 * - a model listed here is not thereby accessible to the user: access is checked separately and never assumed.
 *
 * Maintenance: add entries from a source you opened, with its URL and the date you read it; keep numbers exactly as the
 * source states them, write `unspecified` for an effort or harness it does not state, and bump the version.
 */
export const EVIDENCE_CATALOG_VERSION = '2026-10-30.2';

export type EvidenceKind = 'official-vendor' | 'independent' | 'community';
export type Confidence = 'high' | 'medium' | 'low';
/** What a benchmark measures. Only some of these say anything about a given step (see `STEP_FITS`). */
export type TaskFit =
  | 'general-intelligence'
  | 'agentic-coding'
  | 'code-review'
  | 'planning'
  | 'workflow-automation'
  | 'computer-use'
  | 'scientific-agents';
export type EvidenceMetric = 'index-points' | 'percent';

export interface EvidenceSource {
  readonly id: string;
  readonly url: string;
  readonly publisher: string;
  readonly kind: EvidenceKind;
  /** Date the document says it was published (`YYYY-MM-DD`), when it states one. */
  readonly published?: string;
  /** Date the source says the evaluation was run, when it states one. */
  readonly evaluated?: string;
  /** Release date of the model as the source states it. */
  readonly modelReleased?: string;
  /** Date this catalog read the page (`YYYY-MM-DD`). Not a freshness date of the result. */
  readonly retrieved: string;
  readonly note?: string;
}

interface EvidenceBase {
  readonly sourceId: string;
  /** Comparison group: results are comparable only within one group. */
  readonly group: string;
  readonly provider: 'claude' | 'codex';
  readonly benchmark: string;
  readonly benchmarkVersion: string;
  readonly fit: TaskFit;
  /** Evaluation harness or environment as the source states it, or `unspecified`. */
  readonly harness: string;
  readonly confidence: Confidence;
  readonly note?: string;
}

/** An absolute score of one model. */
export interface EvidenceEntry extends EvidenceBase {
  /** Model id as the provider's API/CLI uses it. */
  readonly model: string;
  /** Model name and variant exactly as the source labels it. */
  readonly variant: string;
  readonly metric: EvidenceMetric;
  /** Absent for a report that has no numeric score. */
  readonly score?: number;
  /** Effort the score was measured at, or `unspecified` when the source does not name a level. */
  readonly effort: string;
}

/** A difference the source states in words or figures, without giving each model's own score. */
export interface EvidenceClaim extends EvidenceBase {
  readonly model: string;
  readonly versus: string;
  /** Percentage points by which `model` is ahead of `versus`, as stated. */
  readonly delta: number;
  readonly effort: string;
  readonly versusEffort: string;
}

export interface EvidenceCatalog {
  readonly version: string;
  readonly sources: readonly EvidenceSource[];
  readonly entries: readonly EvidenceEntry[];
  readonly claims: readonly EvidenceClaim[];
}

const FETCH_NOTE = 'read on 2026-10-30 through a text-extraction tool; check the figure against the URL before relying on it';
const AA_NOTE = 'Artificial Analysis Intelligence Index v5.0; the page states no evaluation date and is a live page marked "Updated"';
const OPENAI_NOTE =
  'read on 2026-10-30 in the in-app browser, which served the tr-TR locale of this page; only figures written in the page text are used, chart values are images and were not read; the page text states no publication or evaluation date; competitors\' results on OpenAI pages come from public reports';
const OPENAI_HARNESS = 'OpenAI research environment or API (system prompts, tools and reasoning level can differ from the released product)';
const AA_HARNESS = 'Artificial Analysis Intelligence Index v5.0 method (one evaluator, all models)';

const sources: readonly EvidenceSource[] = [
  { id: 'aa-opus-5-5', url: 'https://artificialanalysis.ai/models/claude-opus-5-5', publisher: 'Artificial Analysis', kind: 'independent', modelReleased: '2026-09-22', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-sonnet-5-5', url: 'https://artificialanalysis.ai/models/claude-sonnet-5-5', publisher: 'Artificial Analysis', kind: 'independent', modelReleased: '2026-09-28', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-gpt-6-1-sol', url: 'https://artificialanalysis.ai/models/gpt-6-1-sol', publisher: 'Artificial Analysis', kind: 'independent', modelReleased: '2026-09-29', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  { id: 'aa-gpt-6-1-terra', url: 'https://artificialanalysis.ai/models/gpt-6-1-terra', publisher: 'Artificial Analysis', kind: 'independent', modelReleased: '2026-10-26', retrieved: '2026-10-30', note: `${AA_NOTE}; ${FETCH_NOTE}` },
  {
    id: 'anthropic-sonnet-5-5',
    url: 'https://www.anthropic.com/claude-sonnet-5-5',
    publisher: 'Anthropic',
    kind: 'official-vendor',
    published: '2026-09-28',
    retrieved: '2026-10-30',
    note: `launch page, the vendor's own results; ${FETCH_NOTE}`,
  },
  { id: 'openai-gpt-6-1-sol', url: 'https://openai.com/index/introducing-gpt-6-1-sol/', publisher: 'OpenAI', kind: 'official-vendor', retrieved: '2026-10-30', note: OPENAI_NOTE },
  { id: 'openai-gpt-6-1-terra', url: 'https://openai.com/index/introducing-gpt-6-1-terra/', publisher: 'OpenAI', kind: 'official-vendor', retrieved: '2026-10-30', note: OPENAI_NOTE },
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
  fit: 'general-intelligence',
  metric: 'index-points',
  score,
  effort: 'max',
  harness: AA_HARNESS,
  confidence: 'high',
  note: 'a general intelligence index: it is not evidence about coding, code review or planning',
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
  harness: 'unspecified',
  confidence: 'medium',
  ...(note === undefined ? {} : { note }),
});

const entries: readonly EvidenceEntry[] = [
  aa('aa-opus-5-5', 'claude-opus-5-5', 'Claude Opus 5.5 (Max, Default Fallback)', 58, 'claude'),
  aa('aa-sonnet-5-5', 'claude-sonnet-5-5', 'Claude Sonnet 5.5 (max with fallback)', 54, 'claude'),
  aa('aa-gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol (Max)', 55, 'codex'),
  aa('aa-gpt-6-1-terra', 'gpt-6.1-terra', 'GPT-6.1 Terra (max)', 51, 'codex'),
  launch('claude-sonnet-5-5', 'Sonnet 5.5', 'Terminal-Bench', '4.0', 70.6, 'unspecified', 'claude', 'effort and harness not stated for this figure'),
  launch('claude-opus-5-5', 'Opus 5.5', 'Terminal-Bench', '4.0', 66.4, 'xhigh', 'claude', "the page says this is Opus 5.5's highest score, so it is a best case"),
  launch('claude-sonnet-5-5', 'Sonnet 5.5', 'FrontierCode (Main set)', '1.1', 46.2, 'max', 'claude', 'the page says Sonnet 5.5 scored higher at xhigh than at max'),
  launch('claude-opus-5-5', 'Opus 5.5', 'FrontierCode (Main set)', '1.1', 54.4, 'unspecified', 'claude'),
  launch('gpt-6-sol', 'GPT-6 Sol', 'FrontierCode (Main set)', '1.1', 49.3, 'unspecified', 'codex', 'a different model from GPT-6.1 Sol'),
  {
    sourceId: 'openai-gpt-6-1-terra',
    group: 'openai-gpt-6-1-terra-launch',
    provider: 'codex',
    model: 'gpt-6.1-terra',
    variant: 'GPT-6.1 Terra',
    benchmark: 'Terminal-Bench',
    benchmarkVersion: '4.0',
    fit: 'agentic-coding',
    metric: 'percent',
    score: 50.3,
    effort: 'highest',
    harness: OPENAI_HARNESS,
    confidence: 'medium',
    note: 'the page says "highest reasoning effort" without naming the level; it also says GPT-6.1 Sol and GPT-6 Astra remain better choices for the most complex coding tasks, without a figure; it gives no Terminal-Bench 4.0 figure for GPT-6.1 Sol',
  },
  {
    sourceId: 'openai-forum-terra',
    group: 'community-digbench',
    provider: 'codex',
    model: 'gpt-6.1-terra',
    variant: 'GPT-6.1 Terra',
    benchmark: "DigBench (a forum user's own tasks)",
    benchmarkVersion: 'not stated',
    fit: 'agentic-coding',
    metric: 'percent',
    effort: 'high',
    harness: "the forum user's own setup",
    confidence: 'low',
    note: 'no numeric score: one user reported P-1 won twice and P-2 lost twice at high effort; the task changes on every run',
  },
];

const claims: readonly EvidenceClaim[] = [
  {
    sourceId: 'openai-gpt-6-1-sol',
    group: 'openai-gpt-6-1-sol-launch',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    versus: 'gpt-6-sol',
    benchmark: 'DeepSWE',
    benchmarkVersion: '1.1',
    fit: 'agentic-coding',
    delta: 6.4,
    effort: 'unspecified',
    versusEffort: 'unspecified',
    harness: OPENAI_HARNESS,
    confidence: 'medium',
    note: "the page compares GPT-6.1 Sol at a lower reasoning level with GPT-6 Sol's best score, naming neither level, so the efforts are not equivalent",
  },
  {
    sourceId: 'openai-gpt-6-1-sol',
    group: 'openai-gpt-6-1-sol-launch',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    versus: 'gpt-6-sol',
    benchmark: 'AutomationBench',
    benchmarkVersion: '1.0.6',
    fit: 'workflow-automation',
    delta: 4.8,
    effort: 'medium',
    versusEffort: 'medium',
    harness: OPENAI_HARNESS,
    confidence: 'medium',
    note: 'multi-step business workflows with 47 tools, not software engineering',
  },
  {
    sourceId: 'openai-gpt-6-1-sol',
    group: 'openai-gpt-6-1-sol-launch',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    versus: 'gpt-6-sol',
    benchmark: 'OSWorld (offline dataset v2026.08.08, partial reward)',
    benchmarkVersion: '2.0',
    fit: 'computer-use',
    delta: 7,
    effort: 'highest',
    versusEffort: 'highest',
    harness: OPENAI_HARNESS,
    confidence: 'medium',
    note: 'the page says "highest reasoning level" without naming it',
  },
];

export const EVIDENCE_CATALOG: EvidenceCatalog = { version: EVIDENCE_CATALOG_VERSION, sources, entries, claims };
