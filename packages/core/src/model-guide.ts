import type { PolicyName, TaskSize } from './step-policy.ts';
import type { SelectionStep } from './step-selection.ts';
import type { Difficulty } from './evidence-router.ts';

/**
 * What the providers' own documentation says each model is for, kept as data with its source. This is NOT a
 * measurement: it says what a vendor intends a model for and how it positions the models against each other, in the
 * vendor's own (paraphrased) words. `--model-routing guided` uses it for an explainable, clearly labelled
 * intent-based choice, and shows it apart from benchmark evidence (`evidence-catalog.ts`).
 *
 * Only what the sources state is recorded. A model without a documented purpose, a relation nobody stated, or a speed
 * nobody claimed is simply absent; the guide then keeps the provider default. Prices are not recorded (an API price is not
 * your subscription quota), and being listed here says nothing about whether an account can use the model.
 */
export const MODEL_GUIDE_VERSION = '2026-10-31.1';

export type Intent = 'complex-coding' | 'complex-work' | 'focused-coding' | 'focused-work';

export interface GuideSource {
  readonly id: string;
  readonly url: string;
  readonly publisher: string;
  /** Date this guide read the page (`YYYY-MM-DD`). The pages state no date of their own. */
  readonly retrieved: string;
  readonly note?: string;
}

export interface ModelProfile {
  readonly id: string;
  readonly provider: 'claude' | 'codex';
  readonly label: string;
  /** Kinds of work the documentation names for this model. */
  readonly suits: readonly Intent[];
  /** Kinds of work the vendor says this model is not the better choice for. */
  readonly lessSuitedFor: readonly Intent[];
  /** The vendor's positioning, paraphrased. */
  readonly positioning: string;
  /** `balanced` only if the vendor itself labels the model as a balance of speed, cost and intelligence. */
  readonly balanced?: boolean;
  readonly sourceId: string;
}

/** A relation a vendor states between two models on one dimension: `better` is ahead of `than`. */
export interface GuideRelation {
  readonly dimension: 'capability' | 'efficiency';
  readonly better: string;
  readonly than: string;
  readonly statement: string;
  readonly sourceId: string;
}

const OPENAI_API = 'openai-latest-model';
const CODEX_DOCS = 'codex-models';
const TERRA_LAUNCH = 'openai-terra-launch';
const CLAUDE_DOCS = 'claude-models-overview';

export const GUIDE_SOURCES: readonly GuideSource[] = [
  { id: OPENAI_API, url: 'https://developers.openai.com/api/docs/guides/latest-model', publisher: 'OpenAI', retrieved: '2026-10-31', note: 'read through a text-extraction tool' },
  { id: CODEX_DOCS, url: 'https://developers.openai.com/codex/models', publisher: 'OpenAI', retrieved: '2026-10-31', note: 'redirects to learn.chatgpt.com/docs/models; read through a text-extraction tool' },
  { id: TERRA_LAUNCH, url: 'https://openai.com/index/introducing-gpt-6-1-terra/', publisher: 'OpenAI', retrieved: '2026-10-30', note: 'launch page read in the in-app browser (tr-TR locale)' },
  { id: CLAUDE_DOCS, url: 'https://platform.claude.com/docs/en/models/overview', publisher: 'Anthropic', retrieved: '2026-10-31', note: 'read through a text-extraction tool' },
];

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'gpt-6-astra', provider: 'codex', label: 'GPT-6 Astra', suits: ['complex-coding', 'complex-work'], lessSuitedFor: [],
    positioning: 'the most capable model, for the most demanding multi-step work across code, apps and research', sourceId: CODEX_DOCS,
  },
  {
    id: 'gpt-6.1-sol', provider: 'codex', label: 'GPT-6.1 Sol', suits: ['complex-coding', 'complex-work'], lessSuitedFor: [], balanced: true,
    positioning: 'near-Astra performance for complex coding, computer use and professional work at a lower cost; labelled balanced speed, cost and intelligence', sourceId: OPENAI_API,
  },
  {
    id: 'gpt-6.1-terra', provider: 'codex', label: 'GPT-6.1 Terra', suits: [], lessSuitedFor: ['complex-coding'],
    positioning: 'fast and efficient, for visual reasoning, precise computer use and clear writing; OpenAI says GPT-6.1 Sol and GPT-6 Astra remain better choices for the most complex coding tasks', sourceId: TERRA_LAUNCH,
  },
  {
    id: 'gpt-6-luna', provider: 'codex', label: 'GPT-6 Luna', suits: ['focused-coding', 'focused-work'], lessSuitedFor: [],
    positioning: 'the fastest and most cost-effective model, for focused high-volume tasks such as summarization, extraction and focused coding, when you know what a good result looks like', sourceId: CODEX_DOCS,
  },
  {
    id: 'claude-fable-5-1', provider: 'claude', label: 'Claude Fable 5.1', suits: ['complex-work'], lessSuitedFor: [],
    positioning: 'for demanding reasoning and long-horizon agentic work; the slowest of the current lineup', sourceId: CLAUDE_DOCS,
  },
  {
    id: 'claude-opus-5-5', provider: 'claude', label: 'Claude Opus 5.5', suits: ['complex-coding', 'complex-work'], lessSuitedFor: [],
    positioning: 'for long-running agentic coding and knowledge work; the docs suggest starting with it for most workloads; moderate latency', sourceId: CLAUDE_DOCS,
  },
  {
    id: 'claude-sonnet-5-5', provider: 'claude', label: 'Claude Sonnet 5.5', suits: [], lessSuitedFor: [], balanced: true,
    positioning: 'the best combination of speed and intelligence; fast', sourceId: CLAUDE_DOCS,
  },
  {
    id: 'claude-haiku-5-5', provider: 'claude', label: 'Claude Haiku 5.5', suits: ['focused-work'], lessSuitedFor: [],
    positioning: 'for high-volume, latency-sensitive tasks such as classification, extraction and routing; the fastest', sourceId: CLAUDE_DOCS,
  },
];

export const GUIDE_RELATIONS: readonly GuideRelation[] = [
  { dimension: 'capability', better: 'gpt-6-astra', than: 'gpt-6.1-sol', statement: 'Astra is the most capable; Sol delivers near-Astra performance', sourceId: OPENAI_API },
  { dimension: 'efficiency', better: 'gpt-6.1-sol', than: 'gpt-6-astra', statement: 'Sol delivers near-Astra performance at a lower cost than Astra', sourceId: CODEX_DOCS },
  { dimension: 'efficiency', better: 'gpt-6-luna', than: 'gpt-6.1-sol', statement: 'Luna is described as the fastest and most cost-effective', sourceId: OPENAI_API },
  { dimension: 'efficiency', better: 'gpt-6-luna', than: 'gpt-6-astra', statement: 'Luna is described as the fastest and most cost-effective', sourceId: OPENAI_API },
  { dimension: 'efficiency', better: 'gpt-6-luna', than: 'gpt-6.1-terra', statement: 'Luna is described as the fastest and most cost-effective', sourceId: OPENAI_API },
];

/**
 * What kind of work a step is, from the step and the task text only. Both inputs are heuristics, and the result is
 * shown as one. Under the quality policy an easy task is not treated as focused: the user asked for quality, so the
 * guide does not downsize.
 */
export function intentFor(step: SelectionStep, difficulty: Difficulty, policy: PolicyName): Intent {
  const focused = difficulty === 'easy' && policy !== 'quality';
  if (step === 'implement') return focused ? 'focused-coding' : 'complex-coding';
  return focused ? 'focused-work' : 'complex-work';
}

/** The dimension a policy cares about: quality -> capability, economy -> efficiency, balanced -> the vendor's own balanced label. */
export const POLICY_DIMENSION: Readonly<Record<PolicyName, 'capability' | 'efficiency' | 'balanced'>> = {
  quality: 'capability',
  economy: 'efficiency',
  balanced: 'balanced',
};

export type GuideUncertainty = 'medium' | 'high';

export interface GuideInput {
  readonly step: SelectionStep;
  readonly provider: 'claude' | 'codex';
  readonly difficulty: Difficulty;
  readonly size: TaskSize;
  readonly policy: PolicyName;
  /** Models this step could use. Codex: what the provider lists now. Claude: documented ids, access NOT verified. */
  readonly available: readonly string[];
}

export interface GuideDecision {
  readonly model?: string;
  readonly advisoryModel?: string;
  readonly uncertainty: GuideUncertainty;
  readonly note: string;
  readonly lines: readonly string[];
}

/** The candidate that a stated relation puts ahead of every other candidate (directly or through a chain), if there is one. */
function dominant(candidates: readonly string[], dimension: 'capability' | 'efficiency'): { model: string; used: GuideRelation[] } | undefined {
  const edges = GUIDE_RELATIONS.filter((r) => r.dimension === dimension);
  const beats = (a: string, b: string, seen: Set<string> = new Set()): GuideRelation[] | undefined => {
    for (const e of edges.filter((x) => x.better === a)) {
      if (e.than === b) return [e];
      if (!seen.has(e.than)) {
        seen.add(e.than);
        const rest = beats(e.than, b, seen);
        if (rest !== undefined) return [e, ...rest];
      }
    }
    return undefined;
  };
  for (const c of candidates) {
    const used: GuideRelation[] = [];
    let wins = true;
    for (const other of candidates.filter((x) => x !== c)) {
      const path = beats(c, other);
      if (path === undefined) {
        wins = false;
        break;
      }
      used.push(...path);
    }
    if (wins) return { model: c, used };
  }
  return undefined;
}

/**
 * An intent-based choice from vendor documentation: the models the documentation names for this kind of work (minus the
 * ones the vendor says are less suited), narrowed by what the policy prefers using only relations the vendors state. If
 * documentation does not settle it, the provider default is kept. For Claude it only advises: access is never assumed.
 */
export function guideModel(input: GuideInput): GuideDecision {
  const sources = new Map(GUIDE_SOURCES.map((s) => [s.id, s]));
  const intent = intentFor(input.step, input.difficulty, input.policy);
  const dimension = POLICY_DIMENSION[input.policy];
  const lines: string[] = [
    `intent-based reading (vendor documentation, not measurements): step ${input.step}, task difficulty ${input.difficulty} (text heuristic), policy ${input.policy} -> ${intent}, preferring ${dimension === 'balanced' ? "the vendor's own balanced label" : dimension}`,
  ];
  if (input.provider === 'claude') lines.push('claude access: UNKNOWN (no command lists the models this account can use); a Claude model is never pinned automatically');
  const keep = (why: string, uncertainty: GuideUncertainty = 'high', advisoryModel?: string): GuideDecision => ({
    note: `provider default kept: ${why}`,
    uncertainty,
    lines,
    ...(advisoryModel === undefined ? {} : { advisoryModel }),
  });
  const src = (p: ModelProfile): string => {
    const s = sources.get(p.sourceId);
    return s === undefined ? '' : ` [${s.url}, read ${s.retrieved}]`;
  };

  const profiles = input.available.flatMap((id) => {
    const p = MODEL_PROFILES.find((m) => m.id === id && m.provider === input.provider);
    return p === undefined ? [] : [p];
  });
  for (const id of input.available) {
    if (!profiles.some((p) => p.id === id)) lines.push(`${id}: no documented purpose in this guide, not considered`);
  }
  const suited = profiles.filter((p) => p.suits.includes(intent) && !p.lessSuitedFor.includes(intent));
  for (const p of profiles) {
    if (suited.includes(p)) lines.push(`suited by documentation: ${p.id}: ${p.positioning}${src(p)}`);
    else if (p.lessSuitedFor.includes(intent)) lines.push(`vendor says less suited for ${intent}: ${p.id}: ${p.positioning}${src(p)}`);
    else lines.push(`not named for ${intent}: ${p.id}: ${p.positioning}${src(p)}`);
  }
  if (suited.length === 0) return keep(`no available model is documented for ${intent}`);

  const [first, ...others] = suited;
  let chosen: ModelProfile | undefined = first !== undefined && others.length === 0 ? first : undefined;
  if (chosen !== undefined) {
    lines.push(`only one available model is documented for ${intent}: ${chosen.id}`);
  } else if (dimension === 'balanced') {
    const balanced = suited.filter((p) => p.balanced === true);
    if (balanced.length === 1) {
      chosen = balanced[0];
      lines.push(`${chosen?.id ?? ''} is the only suited model the vendor labels as a balance of speed, cost and intelligence`);
    }
  } else {
    const winner = dominant(suited.map((p) => p.id), dimension);
    if (winner !== undefined) {
      chosen = suited.find((p) => p.id === winner.model);
      for (const r of winner.used) lines.push(`${dimension}: ${r.better} ahead of ${r.than}: ${r.statement} [${sources.get(r.sourceId)?.url ?? ''}]`);
    }
  }
  if (chosen === undefined) {
    return keep(`documentation does not settle which of ${suited.map((p) => p.id).join(', ')} fits a ${dimension === 'balanced' ? 'balanced' : dimension} priority`);
  }
  if (input.provider === 'claude') {
    return keep(`documentation points to ${chosen.id}, but a Claude model cannot be shown to be accessible, so none is pinned`, 'high', chosen.id);
  }
  return { model: chosen.id, uncertainty: 'medium', note: `${chosen.id}: documented for ${intent} (${dimension === 'balanced' ? 'balanced' : dimension} priority); intent-based, not measured`, lines };
}
