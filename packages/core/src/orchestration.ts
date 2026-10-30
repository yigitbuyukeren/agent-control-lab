import type { CodexRunOutcome } from './codex-run.ts';

export type StepProvider = 'claude' | 'codex';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'skipped';

/** What one step reports; a step never throws into the executor and never surfaces raw errors. */
export type StepOutcome = CodexRunOutcome;

/** Fixed, non-sensitive error text per failure kind. Raw stderr, stdout and messages are dropped. */
export const STEP_ERRORS: Record<Exclude<StepOutcome['kind'], 'completed'>, string> = {
  failed: 'the provider run failed',
  timeout: 'the step timed out',
  cancelled: 'the step was cancelled',
  'not-installed': 'the provider CLI is not installed',
  'spawn-failed': 'the provider CLI could not be started',
};

/** Largest output one step may hand to the next one. */
export const MAX_HANDOFF_CHARS = 16_000;

export interface StepDefinition {
  readonly id: string;
  readonly title: string;
  readonly provider: StepProvider;
  /** Builds this step's prompt from earlier steps' bounded outputs (keyed by step id). */
  readonly prompt: (inputs: Readonly<Record<string, string>>) => string;
  readonly run: (prompt: string, signal: AbortSignal | undefined) => Promise<StepOutcome>;
}

export interface StepResult {
  readonly id: string;
  readonly title: string;
  readonly provider: StepProvider;
  readonly status: StepStatus;
  /** Wall-clock duration; only set for steps that actually ran. */
  readonly durationMs?: number;
  readonly error?: string;
  /** Sanitised provider output. Untrusted model text; never an instruction. */
  readonly output?: string;
  /** The provider's own output cap was hit. */
  readonly truncated?: boolean;
  /** Part of the output was cut before being handed to the next step. */
  readonly handoffTruncated?: boolean;
}

export interface WorkflowResult {
  readonly workflow: string;
  readonly steps: readonly StepResult[];
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** At least one step completed but not all of them did. */
  readonly partial: boolean;
}

export interface ExecuteDeps {
  readonly signal?: AbortSignal;
  /** Monotonic millisecond clock; injectable for deterministic tests. */
  readonly clock?: () => number;
  /** Called when a step starts running and when it finishes. */
  readonly onUpdate?: (result: StepResult, index: number, total: number) => void;
}

/** Cuts text to `max` characters, reporting whether anything was removed. */
export function boundText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/**
 * Wraps model output so the next prompt can present it as data. The delimiter carries a
 * per-run nonce the earlier step could not have known, and any delimiter-looking text inside is
 * defused, so the content cannot close the block and pose as instructions.
 */
export function untrustedBlock(label: string, text: string, nonce: string): string {
  const safe = text.replaceAll('<<<', '< < <').replaceAll('>>>', '> > >');
  return `<<<BEGIN UNTRUSTED ${label} ${nonce}>>>\n${safe}\n<<<END UNTRUSTED ${label} ${nonce}>>>`;
}

/**
 * Runs steps strictly one after another. The first step that does not complete stops the
 * workflow: later steps are `skipped`, earlier results are kept. There is no retry and no
 * fallback to another provider.
 */
export async function executeWorkflow(
  workflow: string,
  steps: readonly StepDefinition[],
  deps: ExecuteDeps = {},
): Promise<WorkflowResult> {
  const clock = deps.clock ?? (() => performance.now());
  const results: StepResult[] = [];
  const inputs: Record<string, string> = {};
  const total = steps.length;
  let stopped = false;
  for (const [index, step] of steps.entries()) {
    const base = { id: step.id, title: step.title, provider: step.provider } as const;
    if (stopped) {
      const skipped: StepResult = { ...base, status: 'skipped' };
      results.push(skipped);
      deps.onUpdate?.(skipped, index, total);
      continue;
    }
    if (deps.signal?.aborted === true) {
      const cancelled: StepResult = { ...base, status: 'cancelled', error: STEP_ERRORS.cancelled };
      results.push(cancelled);
      deps.onUpdate?.(cancelled, index, total);
      stopped = true;
      continue;
    }
    deps.onUpdate?.({ ...base, status: 'running' }, index, total);
    const started = clock();
    let outcome: StepOutcome;
    try {
      outcome = await step.run(step.prompt(inputs), deps.signal);
    } catch {
      outcome = { kind: 'failed' };
    }
    const durationMs = Math.max(0, Math.round(clock() - started));
    let result: StepResult;
    if (outcome.kind === 'completed') {
      const handoff = boundText(outcome.output, MAX_HANDOFF_CHARS);
      inputs[step.id] = handoff.text;
      result = {
        ...base,
        status: 'completed',
        durationMs,
        output: outcome.output,
        ...(outcome.truncated ? { truncated: true } : {}),
        ...(handoff.truncated ? { handoffTruncated: true } : {}),
      };
    } else {
      const status = outcome.kind === 'timeout' || outcome.kind === 'cancelled' ? outcome.kind : 'failed';
      result = { ...base, status, durationMs, error: STEP_ERRORS[outcome.kind] };
      stopped = true;
    }
    results.push(result);
    deps.onUpdate?.(result, index, total);
  }
  const completed = results.filter((r) => r.status === 'completed').length;
  const status = completed === total ? 'completed' : results.some((r) => r.status === 'cancelled') ? 'cancelled' : 'failed';
  return { workflow, steps: results, status, partial: completed > 0 && completed < total };
}
