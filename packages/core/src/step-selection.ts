import { asEffortLevel } from './models.ts';
import { DEFAULT_REQUEST, type SelectionRequest } from './selection.ts';
import type { WorkflowName } from './workflows.ts';

/** Steps whose model and effort the user can choose. Local steps (inspect, verify) have no model. */
export const SELECTION_STEPS = ['plan', 'implement', 'review'] as const;
export type SelectionStep = (typeof SELECTION_STEPS)[number];
export type SelectionProvider = 'claude' | 'codex';

const STEP_PROVIDERS: Readonly<Record<WorkflowName, Readonly<Partial<Record<SelectionStep, SelectionProvider>>>>> = {
  'plan-review': { plan: 'claude', review: 'codex' },
  'plan-implement-review': { plan: 'claude', implement: 'codex', review: 'claude' },
};

/** The selectable steps of a workflow, in order, with the provider each one runs on. */
export function selectionSteps(workflow: WorkflowName): { step: SelectionStep; provider: SelectionProvider }[] {
  const providers = STEP_PROVIDERS[workflow];
  return SELECTION_STEPS.flatMap((step) => {
    const provider = providers[step];
    return provider === undefined ? [] : [{ step, provider }];
  });
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

/** One step's request and whether each part came from a flag (otherwise the provider default is kept). */
export interface StepRequest {
  readonly request: SelectionRequest;
  readonly modelFromFlag: boolean;
  readonly effortFromFlag: boolean;
  /** Set by the policy step: what the policy did for this step and why. */
  readonly policy?: { readonly name: string; readonly note: string };
  /** Set by adaptive routing: what it decided for the model and the evidence behind it. */
  readonly routing?: { readonly note: string; readonly evidence: readonly string[]; readonly pinned: boolean };
}

export type StepRequests = Readonly<Partial<Record<SelectionStep, StepRequest>>>;

export interface StepFlags {
  /** Raw `--step-model` values: `step=auto|model-id`. */
  readonly models: readonly string[];
  /** Raw `--step-effort` values: `step=auto|level`. */
  readonly efforts: readonly string[];
}

function splitSetting(flag: string, text: string): { step: string; value: string } | string {
  const at = text.indexOf('=');
  if (at < 1 || at === text.length - 1) return `${flag} needs step=value, for example ${flag} plan=auto`;
  return { step: text.slice(0, at), value: text.slice(at + 1) };
}

/**
 * Builds one request per selectable step. Every problem is reported and nothing is guessed: an
 * unknown step, a step the workflow does not have, a repeated step or a malformed value is
 * refused. Mode is always `normal`: ultracode is never chosen here.
 */
export function buildStepRequests(workflow: WorkflowName, flags: StepFlags): StepRequests | string {
  const steps = selectionSteps(workflow).map((s) => s.step);
  const collected = new Map<SelectionStep, { model?: string; effort?: string }>();
  for (const [flag, kind, list] of [['--step-model', 'model', flags.models], ['--step-effort', 'effort', flags.efforts]] as const) {
    for (const text of list) {
      const parsed = splitSetting(flag, text);
      if (typeof parsed === 'string') return parsed;
      const step = SELECTION_STEPS.find((s) => s === parsed.step);
      if (step === undefined) return `${flag}: unknown step (use ${SELECTION_STEPS.join(', ')})`;
      if (!steps.includes(step)) return `${flag}: ${workflow} has no ${step} step (steps: ${steps.join(', ')})`;
      const entry = collected.get(step) ?? {};
      if (entry[kind] !== undefined) return `${flag}: ${step} is set more than once`;
      if (kind === 'model') {
        if (parsed.value !== 'auto' && !isModelId(parsed.value)) return `${flag}: ${step} needs auto or a model id`;
      } else if (parsed.value === 'ultracode') {
        return `${flag}: ultracode is a work mode, not an effort, and is never selected here`;
      } else if (parsed.value !== 'auto' && asEffortLevel(parsed.value) === undefined) {
        return `${flag}: ${step} needs auto or a level such as low, medium, high, xhigh, max`;
      }
      collected.set(step, { ...entry, [kind]: parsed.value });
    }
  }
  const result: Partial<Record<SelectionStep, StepRequest>> = {};
  for (const step of steps) {
    const entry = collected.get(step);
    result[step] = {
      request: { ...DEFAULT_REQUEST, model: entry?.model ?? DEFAULT_REQUEST.model, effort: entry?.effort ?? DEFAULT_REQUEST.effort },
      modelFromFlag: entry?.model !== undefined,
      effortFromFlag: entry?.effort !== undefined,
    };
  }
  return result;
}
