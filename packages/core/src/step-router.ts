import type { CodexModelsResult } from './models.ts';
import { ladderLevel, wantedLevel, type PolicyName, type TaskSize } from './step-policy.ts';
import type { QuotaLevel } from './routing.ts';
import type { SelectionStep } from './step-selection.ts';

export const MODEL_ROUTINGS = ['auto', 'adaptive'] as const;
export type ModelRouting = (typeof MODEL_ROUTINGS)[number];

export function isModelRouting(value: string): value is ModelRouting {
  return (MODEL_ROUTINGS as readonly string[]).includes(value);
}

export type TaskSensitivity = 'general' | 'sensitive';

const SENSITIVE = /\b(security|auth(?:n|z|entic\w*|oriz\w*)?|migrat\w*|concurren\w*|race condition|deadlock|crypto\w*|secrets?|passwords?|credentials?|data loss|güvenlik|migrasyon|eşzamanlılık|şifre)\b/i;

/** A keyword check on the task text. It is a heuristic, shown as such, and never decides a model by itself. */
export function classifyTask(task: string): TaskSensitivity {
  return SENSITIVE.test(task) ? 'sensitive' : 'general';
}

export interface ModelRouteInput {
  readonly step: SelectionStep;
  readonly provider: 'claude' | 'codex';
  readonly policy: PolicyName;
  readonly size: TaskSize;
  readonly kind: TaskSensitivity;
  /** The provider's own model list; `undefined` when it was not read. */
  readonly catalog: CodexModelsResult | undefined;
  /** Only a fresh or live reading; anything else is `unknown`. */
  readonly quota: QuotaLevel;
}

/** `model` is absent when the provider default is kept; the evidence and note are always present. */
export interface ModelRouteDecision {
  readonly model?: string;
  readonly note: string;
  readonly evidence: readonly string[];
}

/**
 * Picks a model only when the provider's own listing leaves exactly one that supports the effort level the
 * task calls for. There is no verified quality or cost ranking, so a choice among several qualifying models,
 * or no distinction between them, keeps the provider default. Claude models are never pinned: nothing proves
 * what the account can use. Ultracode is never involved.
 */
export function routeModel(input: ModelRouteInput): ModelRouteDecision {
  const evidence = [`role: ${input.step} (${input.provider})`, `task: ${input.kind} (keyword heuristic), size ${input.size} (text-length heuristic)`];
  const keep = (why: string): ModelRouteDecision => ({ note: `provider default kept: ${why}`, evidence });
  if (input.provider === 'claude') {
    evidence.push('claude access: UNKNOWN (no command lists the models this account can use)');
    return keep('a Claude model cannot be shown to be accessible, so none is pinned automatically');
  }
  const { catalog } = input;
  if (catalog?.state !== 'ok') {
    evidence.push(`codex model list: ${catalog === undefined ? 'not read' : catalog.state}`);
    return keep('the Codex model list is not available');
  }
  const known = catalog.models;
  evidence.push(`codex model list: ${String(known.length)} model(s) from model/list`);
  if (known.length < 2) return keep('the list offers no alternative to choose between');
  const { wanted, parts } = wantedLevel({ policy: input.policy, step: input.step, size: input.size, quota: input.quota, ...(input.kind === 'sensitive' ? { sensitive: true } : {}) });
  const level = ladderLevel(Math.min(Math.max(wanted, 0), 5));
  evidence.push(`target effort: ${level ?? '?'} (${parts.join('; ')})`);
  if (level === undefined) return keep('no target effort level');
  const supports = (m: (typeof known)[number]): boolean => m.efforts.status === 'known' && m.efforts.supported.includes(level);
  const fits = known.filter(supports);
  const unreported = known.filter((m) => m.efforts.status !== 'known').length;
  evidence.push(`models supporting ${level}: ${fits.length === 0 ? 'none' : fits.map((m) => m.id).join(', ')}${unreported > 0 ? ` (${String(unreported)} reported no efforts)` : ''}`);
  if (fits.length === 0) return keep(`no listed model reports supporting ${level}`);
  if (fits.length === known.length) return keep(`every listed model supports ${level}, and there is no verified ranking to choose between them`);
  const only = fits[0];
  if (fits.length > 1 || only === undefined) return keep(`${String(fits.length)} models support ${level} and there is no verified ranking to choose between them`);
  if (unreported > 0) return keep(`${String(unreported)} listed model(s) report no efforts, so ${only.id} is not provably the only one`);
  return { model: only.id, note: `${only.id}: the only listed model that supports ${level}`, evidence };
}
