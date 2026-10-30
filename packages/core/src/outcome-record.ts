import type { WorkflowResult } from './orchestration.ts';
import { isModelId, type SelectionStep } from './step-selection.ts';
import type { TaskSize } from './step-policy.ts';
import type { TaskSensitivity } from './step-router.ts';

/**
 * Local outcome records for measured model routing. Privacy by construction: a record holds no task text, no
 * model output, no path, no session id and no exact time. Only the facts below are kept.
 *
 * What counts as evidence: `pass` is a verification command that exited 0 on the change, `fail` is a failed
 * verification command or a change the local inspection rejected. Anything the model says about its own work
 * (a review verdict, "done") is never evidence. `unmeasured` (completed, nothing objective to check), `error`
 * (provider failed) and `timeout` are kept for duration and reliability but do not enter the success rate.
 */
export const OUTCOME_KINDS = ['pass', 'fail', 'error', 'timeout', 'unmeasured'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface OutcomeRecord {
  readonly v: 1;
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly step: SelectionStep;
  readonly provider: 'claude' | 'codex';
  /** A model id the user or routing pinned, or `default` (the provider's own choice, unknown here). */
  readonly model: string;
  /** An effort level, or `default`. */
  readonly effort: string;
  readonly task: TaskSensitivity;
  readonly size: TaskSize;
  readonly outcome: OutcomeKind;
  /** Whole seconds. */
  readonly seconds: number;
}

/** Where records live; failures to read or write must never break a run. */
export interface OutcomeStore {
  load(): Promise<readonly OutcomeRecord[]>;
  append(records: readonly OutcomeRecord[]): Promise<void>;
  clear(): Promise<void>;
}

export const MAX_STORED_RECORDS = 2000;

const STEPS: readonly string[] = ['plan', 'implement', 'review'];
const SIZES: readonly string[] = ['small', 'normal', 'large'];
const TASKS: readonly string[] = ['general', 'sensitive'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EFFORT = /^[a-z]{2,12}$/;

/** Strict whitelist parse: unknown fields are dropped, anything malformed yields `undefined`. */
export function parseOutcomeLine(line: string): OutcomeRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const r = data as Record<string, unknown>;
  const { day, step, provider, model, effort, task, size, outcome, seconds } = r;
  if (r['v'] !== 1 || typeof day !== 'string' || !DAY.test(day)) return undefined;
  if (typeof step !== 'string' || !STEPS.includes(step)) return undefined;
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  if (typeof model !== 'string' || (model !== 'default' && !isModelId(model))) return undefined;
  if (typeof effort !== 'string' || !EFFORT.test(effort) || effort === 'ultracode') return undefined;
  if (typeof task !== 'string' || !TASKS.includes(task) || typeof size !== 'string' || !SIZES.includes(size)) return undefined;
  if (typeof outcome !== 'string' || !(OUTCOME_KINDS as readonly string[]).includes(outcome)) return undefined;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return undefined;
  return {
    v: 1,
    day,
    step: step as SelectionStep,
    provider,
    model,
    effort,
    task: task as TaskSensitivity,
    size: size as TaskSize,
    outcome: outcome as OutcomeKind,
    seconds: Math.round(seconds),
  };
}

export function serializeOutcome(record: OutcomeRecord): string {
  return JSON.stringify(record);
}

export interface RunFacts {
  readonly day: string;
  readonly task: TaskSensitivity;
  readonly size: TaskSize;
  /** What each selectable step was started with (`auto` for a provider default). */
  readonly steps: Readonly<Partial<Record<SelectionStep, { provider: 'claude' | 'codex'; model: string; effort: string }>>>;
}

/** Turns a finished workflow into records. A cancelled or skipped step produces none. */
export function recordsFromRun(result: WorkflowResult, facts: RunFacts): OutcomeRecord[] {
  const byId = new Map(result.steps.map((s) => [s.id, s]));
  const records: OutcomeRecord[] = [];
  for (const step of ['plan', 'implement', 'review'] as const) {
    const used = facts.steps[step];
    const r = byId.get(step);
    if (used === undefined || r === undefined) continue;
    if (r.status === 'pending' || r.status === 'running' || r.status === 'skipped' || r.status === 'cancelled') continue;
    let outcome: OutcomeKind;
    if (r.status === 'timeout') outcome = 'timeout';
    else if (r.status === 'failed') outcome = 'error';
    else if (step !== 'implement') outcome = 'unmeasured';
    else {
      const inspect = byId.get('inspect');
      const verify = byId.get('verify');
      if (inspect?.status === 'failed' || verify?.status === 'failed') outcome = 'fail';
      else if (verify?.status === 'completed' && inspect?.status === 'completed') outcome = 'pass';
      else outcome = 'unmeasured';
    }
    records.push({
      v: 1,
      day: facts.day,
      step,
      provider: used.provider,
      model: used.model === 'auto' ? 'default' : used.model,
      effort: used.effort === 'auto' ? 'default' : used.effort,
      task: facts.task,
      size: facts.size,
      outcome,
      seconds: Math.round((r.durationMs ?? 0) / 1000),
    });
  }
  return records;
}
