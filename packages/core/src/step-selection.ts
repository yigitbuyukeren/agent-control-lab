import { asEffortLevel } from './models.ts';
import { DEFAULT_REQUEST, type SelectionRequest } from './selection.ts';
import { DEFAULT_PROFILE, isPermissionProfile, profileProblem, type PermissionProfile } from './permission-profile.ts';
import type { WorkflowName } from './workflows.ts';

/** Steps whose model and effort the user can choose. Local steps (inspect, verify) have no model. */
export const SELECTION_STEPS = ['plan', 'implement', 'review'] as const;
export type SelectionStep = (typeof SELECTION_STEPS)[number];
export type SelectionProvider = 'claude' | 'codex';

const STEP_PROVIDERS: Readonly<Record<WorkflowName, Readonly<Partial<Record<SelectionStep, SelectionProvider>>>>> = {
  'plan-review': { plan: 'claude', review: 'codex' },
  'plan-implement-review': { plan: 'claude', implement: 'codex', review: 'claude' },
};

/** Every selectable step may run on either provider: both have a permission-profiled runner. */
export const PROVIDER_CHOICE_STEPS: readonly SelectionStep[] = SELECTION_STEPS;

export function isSelectionProvider(value: string): value is SelectionProvider {
  return value === 'claude' || value === 'codex';
}

/** The provider a step runs on when the user does not choose one. */
export function defaultProvider(workflow: WorkflowName, step: SelectionStep): SelectionProvider | undefined {
  return STEP_PROVIDERS[workflow][step];
}

/**
 * The selectable steps of a workflow, in order, with the provider each one runs on: the one chosen in
 * `requests` (`--step-provider`), otherwise the workflow's default.
 */
export function selectionSteps(workflow: WorkflowName, requests?: StepRequests): { step: SelectionStep; provider: SelectionProvider }[] {
  const providers = STEP_PROVIDERS[workflow];
  return SELECTION_STEPS.flatMap((step) => {
    const provider = providers[step];
    return provider === undefined ? [] : [{ step, provider: requests?.[step]?.provider ?? provider }];
  });
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

/** One step's request and whether each part came from a flag (otherwise the provider default is kept). */
export interface StepRequest {
  readonly request: SelectionRequest;
  /** Set only when the user chose the provider (`--step-provider step=claude|codex`); absent means the workflow default. */
  readonly provider?: SelectionProvider;
  /** Set only when the user chose the permission profile (`--step-profile step=...`); absent means the step's default. */
  readonly profile?: PermissionProfile;
  readonly modelFromFlag: boolean;
  readonly effortFromFlag: boolean;
  /** Set by the policy step: what the policy did for this step and why. */
  readonly policy?: { readonly name: string; readonly note: string };
  /** Set by adaptive routing: what it decided for the model and the evidence behind it. */
  readonly routing?: {
    readonly note: string;
    readonly evidence: readonly string[];
    readonly pinned: boolean;
    /** `guided` only: what the choice rests on, and how sure it is. */
    readonly basis?: 'benchmark-evidence' | 'documented-intent' | 'default';
    readonly uncertainty?: 'low' | 'medium' | 'high';
  };
}

export type StepRequests = Readonly<Partial<Record<SelectionStep, StepRequest>>>;

export interface StepFlags {
  /** Raw `--step-model` values: `step=auto|model-id`. */
  readonly models: readonly string[];
  /** Raw `--step-effort` values: `step=auto|level`. */
  readonly efforts: readonly string[];
  /** Raw `--step-provider` values: `step=auto|claude|codex`. */
  readonly providers?: readonly string[];
  /** Raw `--step-profile` values: `step=auto|text-only|read-only|workspace-write`. */
  readonly profiles?: readonly string[];
}

/** The permission profile a step runs with: the chosen one, otherwise the step's default. */
export function stepProfile(requests: StepRequests, step: SelectionStep): PermissionProfile {
  return requests[step]?.profile ?? DEFAULT_PROFILE[step];
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
  const collected = new Map<SelectionStep, { model?: string; effort?: string; provider?: string; profile?: string }>();
  for (const [flag, kind, list] of [['--step-model', 'model', flags.models], ['--step-effort', 'effort', flags.efforts], ['--step-provider', 'provider', flags.providers ?? []], ['--step-profile', 'profile', flags.profiles ?? []]] as const) {
    for (const text of list) {
      const parsed = splitSetting(flag, text);
      if (typeof parsed === 'string') return parsed;
      const step = SELECTION_STEPS.find((s) => s === parsed.step);
      if (step === undefined) return `${flag}: unknown step (use ${SELECTION_STEPS.join(', ')})`;
      if (!steps.includes(step)) return `${flag}: ${workflow} has no ${step} step (steps: ${steps.join(', ')})`;
      const entry = collected.get(step) ?? {};
      if (entry[kind] !== undefined) return `${flag}: ${step} is set more than once`;
      if (kind === 'provider') {
        if (parsed.value !== 'auto' && !isSelectionProvider(parsed.value)) return `${flag}: ${step} needs auto, claude or codex`;
      } else if (kind === 'profile') {
        if (parsed.value !== 'auto' && !isPermissionProfile(parsed.value)) return `${flag}: ${step} needs auto, text-only, read-only or workspace-write`;
      } else if (kind === 'model') {
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
    const chosen = entry?.provider;
    const profile = entry?.profile !== undefined && isPermissionProfile(entry.profile) ? entry.profile : undefined;
    if (profile !== undefined) {
      const effective = chosen === 'claude' || chosen === 'codex' ? chosen : STEP_PROVIDERS[workflow][step];
      const problem = effective === undefined ? undefined : profileProblem(step, effective, profile);
      if (problem !== undefined) return `--step-profile: ${problem}`;
    }
    result[step] = {
      ...(chosen === 'claude' || chosen === 'codex' ? { provider: chosen } : {}),
      ...(profile === undefined ? {} : { profile }),
      request: { ...DEFAULT_REQUEST, model: entry?.model ?? DEFAULT_REQUEST.model, effort: entry?.effort ?? DEFAULT_REQUEST.effort },
      modelFromFlag: entry?.model !== undefined,
      effortFromFlag: entry?.effort !== undefined,
    };
  }
  return result;
}
