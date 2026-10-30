import type { EffortLevel, ModelCapability } from './models.ts';
import type { QuotaLevel } from './routing.ts';
import type { SelectionStep } from './step-selection.ts';

export const POLICY_NAMES = ['economy', 'balanced', 'quality'] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];
export const DEFAULT_POLICY: PolicyName = 'balanced';

export function isPolicyName(value: string): value is PolicyName {
  return (POLICY_NAMES as readonly string[]).includes(value);
}

export type TaskSize = 'small' | 'normal' | 'large';

/**
 * A rough size class from the task text alone (length and line count). It says nothing about how
 * hard the task really is; it only nudges the effort by one level.
 */
export function estimateTaskSize(task: string): TaskSize {
  const lines = task.split('\n').length;
  if (task.length > 800 || lines >= 12) return 'large';
  if (task.length < 200 && lines <= 2) return 'small';
  return 'normal';
}

/**
 * Known effort names in increasing order. A supported level that is not listed here cannot be
 * ordered and is never chosen by a policy. `ultracode` is a work mode, never a level, so it is
 * deliberately absent.
 */
const LADDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const BASE_LEVEL: Readonly<Record<PolicyName, string>> = { economy: 'low', balanced: 'medium', quality: 'high' };

/** What a policy knows about a step's model. Only the user's own pinned model counts. */
export type PolicyModel =
  | { readonly kind: 'auto' }
  | { readonly kind: 'pinned'; readonly id: string; readonly capability: ModelCapability | undefined };

export interface PolicyInput {
  readonly policy: PolicyName;
  readonly step: SelectionStep;
  readonly size: TaskSize;
  readonly model: PolicyModel;
  /** Only a fresh or live reading; anything else must be passed as `unknown`. */
  readonly quota: QuotaLevel;
  /** Adaptive routing only: the task text mentions a risky area (see `classifyTask`); +1. */
  readonly sensitive?: boolean;
}

/** `effort` is absent when the policy keeps the provider default; `note` always says why. */
export interface PolicyDecision {
  readonly effort?: string;
  readonly note: string;
}

const KEPT = 'provider default kept';

/** The level a policy aims for, as an index into the ladder, with the reasons. Needs no model. */
export function wantedLevel(input: Omit<PolicyInput, 'model'>): { wanted: number; parts: string[] } {
  let wanted = LADDER.indexOf(BASE_LEVEL[input.policy]);
  const parts = [`${input.policy} base ${BASE_LEVEL[input.policy]}`];
  if (input.policy === 'quality' && input.step === 'plan') {
    wanted += 1;
    parts.push('plan steers every later step +1');
  }
  if (input.size === 'large') {
    wanted += 1;
    parts.push('large task text +1');
  } else if (input.size === 'small' && input.policy !== 'economy') {
    wanted -= 1;
    parts.push('small task text -1');
  }
  if (input.sensitive === true) {
    wanted += 1;
    parts.push('sensitive-looking task text +1');
  }
  if (input.quota === 'low' || input.quota === 'critical' || input.quota === 'exhausted') {
    wanted -= 1;
    parts.push(`quota ${input.quota} -1`);
  } else if (input.quota === 'unknown') {
    parts.push('quota unknown, not used');
  } else {
    parts.push('quota ok');
  }
  return { wanted, parts };
}

/** Level name for a ladder index, or undefined when it is off the ladder. */
export function ladderLevel(index: number): string | undefined {
  return LADDER[index];
}

/**
 * Chooses an effort only when it can be verified: the user pinned the model and the provider
 * reported which levels it supports. It never picks a model (there is no verified cost or
 * capability ranking to choose by), never guesses quota and never chooses ultracode.
 */
export function decideEffort(input: PolicyInput): PolicyDecision {
  const { model } = input;
  if (model.kind === 'auto') {
    return { note: `${KEPT}: the model is not pinned, so its supported efforts are unknown and nothing could be verified` };
  }
  const efforts = model.capability?.efforts;
  if (model.capability === undefined || efforts?.status !== 'known') {
    return { note: `${KEPT}: supported efforts of ${model.id} are not verified (not listed or not reported by the provider)` };
  }
  const levels = efforts.supported.filter((level): level is EffortLevel => LADDER.includes(level)).sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b));
  const lowest = levels[0];
  if (lowest === undefined) return { note: `${KEPT}: none of the supported efforts of ${model.id} is a level this tool can order` };

  const { wanted, parts } = wantedLevel(input);
  const fit = levels.filter((level) => LADDER.indexOf(level) <= wanted).at(-1);
  const chosen = fit ?? lowest;
  if (fit === undefined) parts.push(`${chosen} is the lowest level ${model.id} supports`);
  else if (LADDER.indexOf(chosen) < wanted) parts.push(`${chosen} is the closest supported level at or below the target`);
  return { effort: chosen, note: `${chosen} (${parts.join('; ')}); size is a text-length heuristic only` };
}
