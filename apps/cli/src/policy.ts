import {
  claudeRegistry,
  classifyQuota,
  chooseMeasured,
  classifyTask,
  decideEffort,
  discoverCodexModels,
  estimateTaskSize,
  readAllQuotas,
  routeModel,
  resolveCacheDir,
  selectionSteps,
  type CodexModelsResult,
  type ModelCapability,
  type ModelRouting,
  type OutcomeRecord,
  type OutcomeStore,
  type PolicyName,
  type ProviderQuota,
  type QuotaLevel,
  type StepRequest,
  type StepRequests,
  type WorkflowName,
} from '@agent-control-lab/core';
import type { PreflightDeps } from './preflight.ts';

export interface PolicyDeps extends PreflightDeps {
  /** Claude statusLine cache directory; defaults to the standard one. */
  readonly cacheDir?: string;
  readonly now?: () => Date;
  /** Local outcome records for `--model-routing measured`; absent means there is no data. */
  readonly outcomes?: OutcomeStore;
}

export interface PolicyResult {
  readonly requests: StepRequests;
  /** Preflight dependencies that reuse the model catalog read here. */
  readonly deps: PreflightDeps;
  /** One line for the plan: where the quota came from, or that it was not needed. */
  readonly quotaNote: string;
}

/** Only a fresh or live reading counts; stale, partial or missing data is `unknown`, never "fine". */
export function reliableQuota(quota: ProviderQuota | undefined): QuotaLevel {
  return quota !== undefined && (quota.freshness === 'live' || quota.freshness === 'fresh') ? classifyQuota(quota) : 'unknown';
}

/**
 * Applies the cost policy to every step whose effort the user left alone. A step the user set
 * (model or effort, including an explicit `auto`) keeps exactly that: manual choices win. Reads
 * only local state (model/list, the quota cache and rate limits); no model is called.
 */
export async function applyPolicy(
  workflow: WorkflowName,
  policy: PolicyName,
  task: string,
  requests: StepRequests,
  deps: PolicyDeps,
  routing: ModelRouting = 'auto',
): Promise<PolicyResult> {
  const size = estimateTaskSize(task);
  const kind = routing === 'auto' ? 'general' : classifyTask(task);
  let loaded: Promise<readonly OutcomeRecord[]> | undefined;
  const records = (): Promise<readonly OutcomeRecord[]> => (loaded ??= (deps.outcomes?.load() ?? Promise.resolve([])).catch(() => []));
  let catalog: Promise<CodexModelsResult> | undefined;
  const codexCatalog = (): Promise<CodexModelsResult> => (catalog ??= discoverCodexModels(deps.appServer));
  let quotas: Promise<ProviderQuota[]> | undefined;
  const readQuotas = (): Promise<ProviderQuota[]> =>
    (quotas ??= readAllQuotas({
      claudeCacheDir: deps.cacheDir ?? resolveCacheDir(),
      ...(deps.appServer === undefined ? {} : { appServer: deps.appServer }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }));

  const result: Partial<Record<keyof StepRequests, StepRequest>> = {};
  let quotaRead = false;
  for (const { step, provider } of selectionSteps(workflow)) {
    let current = requests[step];
    if (current === undefined) continue;
    if (routing === 'measured') {
      if (current.modelFromFlag || current.effortFromFlag) {
        current = {
          ...current,
          routing: {
            note: current.modelFromFlag ? 'not applied: the model was set manually' : 'not applied: the effort was set manually; the model stays with the provider default',
            evidence: [],
            pinned: false,
          },
        };
      } else {
        const decision = chooseMeasured(deps.outcomes === undefined ? [] : await records(), { provider, step, task: kind, size }, (deps.now ?? (() => new Date()))());
        const evidence = deps.outcomes === undefined ? ['no local outcome store available', ...decision.evidence] : [...decision.evidence];
        const choice = decision.choice;
        let note = decision.note;
        let applied: { model: string; effort: string } | undefined;
        if (choice !== undefined) {
          const list = provider === 'codex' ? await codexCatalog() : undefined;
          const listed = list?.state === 'ok' ? list.models.find((m) => m.id === choice.model) : undefined;
          const efforts = listed?.efforts;
          if (provider !== 'codex') {
            note = 'provider default kept: a Claude model cannot be shown to be accessible';
          } else if (listed === undefined) {
            note = `provider default kept: ${choice.model} is not in the Codex model list now`;
          } else if (choice.effort !== 'default' && !(efforts?.status === 'known' && efforts.supported.includes(choice.effort))) {
            note = `provider default kept: ${choice.model} is not reported to support ${choice.effort} now`;
          } else {
            applied = choice;
          }
          evidence.push(applied === undefined ? `not applied: ${note}` : `${choice.model} is listed by the provider now${choice.effort === 'default' ? '' : ` and supports ${choice.effort}`}`);
        }
        const next: StepRequest = {
          ...current,
          request: applied === undefined ? current.request : { ...current.request, model: applied.model, ...(applied.effort === 'default' ? {} : { effort: applied.effort }) },
          routing: { note, evidence, pinned: applied !== undefined },
        };
        if (applied !== undefined) {
          result[step] = { ...next, policy: { name: policy, note: 'the effort comes from the measured group, not from the policy' } };
          continue;
        }
        current = next;
      }
    } else if (routing === 'adaptive') {
      if (current.modelFromFlag || current.effortFromFlag) {
        current = {
          ...current,
          routing: {
            note: current.modelFromFlag ? 'not applied: the model was set manually' : 'not applied: the effort was set manually; the model stays with the provider default',
            evidence: [],
            pinned: false,
          },
        };
      } else {
        const list = provider === 'codex' ? await codexCatalog() : undefined;
        let routeQuota: QuotaLevel = 'unknown';
        if (list?.state === 'ok' && list.models.length >= 2) {
          quotaRead = true;
          routeQuota = reliableQuota((await readQuotas()).find((q) => q.provider === provider));
        }
        const decision = routeModel({ step, provider, policy, size, kind, catalog: list, quota: routeQuota });
        current = {
          ...current,
          request: decision.model === undefined ? current.request : { ...current.request, model: decision.model },
          routing: { note: decision.note, evidence: decision.evidence, pinned: decision.model !== undefined },
        };
      }
    }
    if (current.effortFromFlag) {
      result[step] = { ...current, policy: { name: policy, note: 'not applied: the effort was set manually' } };
      continue;
    }
    const pinned = current.request.model !== 'auto';
    let capability: ModelCapability | undefined;
    if (pinned) {
      const found = provider === 'claude' ? undefined : await codexCatalog();
      const list: readonly ModelCapability[] = provider === 'claude' ? claudeRegistry : found?.state === 'ok' ? found.models : [];
      capability = list.find((m) => m.id === current.request.model);
    }
    const verifiable = capability?.efforts.status === 'known';
    let quota: QuotaLevel = 'unknown';
    if (verifiable) {
      quotaRead = true;
      quota = reliableQuota((await readQuotas()).find((q) => q.provider === provider));
    }
    const decision = decideEffort({
      policy,
      step,
      size,
      model: pinned ? { kind: 'pinned', id: current.request.model, capability } : { kind: 'auto' },
      quota,
      ...(kind === 'sensitive' && routing === 'adaptive' ? { sensitive: true } : {}),
    });
    result[step] = {
      ...current,
      request: decision.effort === undefined ? current.request : { ...current.request, effort: decision.effort },
      policy: { name: policy, note: decision.note },
    };
  }
  return {
    requests: result,
    deps: catalog === undefined ? deps : { ...deps, codexModels: () => codexCatalog() },
    quotaNote: quotaRead ? 'read (a stale, partial or missing reading counts as unknown and is not used)' : 'not read (no step had a verifiable model to adjust)',
  };
}
