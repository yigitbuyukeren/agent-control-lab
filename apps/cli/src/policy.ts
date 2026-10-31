import {
  claudeRegistry,
  classifyQuota,
  chooseMeasured,
  classifyTask,
  decideEffort,
  difficultyOf,
  guideModel,
  ladderLevel,
  recommendFromEvidence,
  wantedLevel,
  discoverCodexModels,
  estimateTaskSize,
  readAllQuotas,
  routeModel,
  resolveCacheDir,
  selectionSteps,
  type CodexModelsResult,
  type EvidenceCatalog,
  type ModelCapability,
  type ModelRouting,
  type OutcomeRecord,
  type OutcomeStore,
  type PolicyName,
  type ProviderQuota,
  type SelectionStep,
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
  /** Evidence catalog for `--model-routing research`; tests inject one, otherwise the shipped catalog is used. */
  readonly evidenceCatalog?: EvidenceCatalog;
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
  group?: string,
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
  /** The strict benchmark-evidence decision of `--model-routing research` for one step, applied only to a model the provider lists now. */
  const strictEvidence = async (step: SelectionStep, provider: 'claude' | 'codex') => {
    const list = provider === 'codex' ? await codexCatalog() : undefined;
    const available = provider === 'claude' ? claudeRegistry.map((m) => m.id) : list?.state === 'ok' ? list.models.map((m) => m.id) : [];
    let routeQuota: QuotaLevel = 'unknown';
    if (list?.state === 'ok' && list.models.length >= 2) {
      quotaRead = true;
      routeQuota = reliableQuota((await readQuotas()).find((q) => q.provider === provider));
    }
    const target = ladderLevel(Math.max(0, wantedLevel({ policy, step, size, quota: routeQuota, ...(kind === 'sensitive' ? { sensitive: true } : {}) }).wanted));
    const decision = recommendFromEvidence({
      step,
      provider,
      difficulty: difficultyOf(size, kind),
      targetEffort: target,
      available,
      now: (deps.now ?? (() => new Date()))(),
      ...(deps.evidenceCatalog === undefined ? {} : { catalog: deps.evidenceCatalog }),
    });
    const evidence = [...(provider === 'codex' && list?.state !== 'ok' ? ['codex model list: not available, so no Codex model can be shown to be accessible'] : []), ...decision.evidence];
    let note = decision.note;
    let applied: { model: string; effort: string } | undefined;
    if (decision.model !== undefined && decision.evidenceEffort !== undefined) {
      const listed = list?.state === 'ok' ? list.models.find((m) => m.id === decision.model) : undefined;
      const efforts = listed?.efforts;
      if (efforts?.status === 'known' && efforts.supported.includes(decision.evidenceEffort)) {
        applied = { model: decision.model, effort: decision.evidenceEffort };
        evidence.push(`${decision.model} is listed by the provider now and supports effort ${decision.evidenceEffort}, the effort the evidence was measured at`);
      } else {
        note = `provider default kept: ${decision.model} is not reported to support effort ${decision.evidenceEffort} now`;
        evidence.push(`not applied: ${note}`);
      }
    }
    return { list, available, decision, evidence, note, applied };
  };
  for (const { step, provider } of selectionSteps(workflow, requests)) {
    let current = requests[step];
    if (current === undefined) continue;
    if (routing === 'guided') {
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
        const strict = await strictEvidence(step, provider);
        const header = `benchmark evidence (strict, the same rules as --model-routing research): ${strict.note}`;
        if (strict.applied !== undefined) {
          const guide = guideModel({ step, provider, difficulty: difficultyOf(size, kind), size, policy, available: strict.available });
          const agree = guide.model === undefined ? 'documentation does not point to a model' : guide.model === strict.applied.model ? 'the documented intent agrees' : `the documented intent points to ${guide.model} instead; the measured evidence is used`;
          result[step] = {
            ...current,
            request: { ...current.request, model: strict.applied.model, effort: strict.applied.effort },
            routing: {
              note: `${strict.applied.model}: ${strict.note}`,
              evidence: [header, ...strict.evidence, `intent-based reading (shown separately, vendor documentation): ${agree}`, ...guide.lines],
              pinned: true,
              basis: 'benchmark-evidence',
              uncertainty: 'low',
            },
            policy: { name: policy, note: 'the effort equals the effort the published evidence was measured at, not a separate policy choice' },
          };
          continue;
        }
        const guide = guideModel({ step, provider, difficulty: difficultyOf(size, kind), size, policy, available: strict.available });
        const listed = guide.model === undefined || strict.list?.state !== 'ok' ? undefined : strict.list.models.find((m) => m.id === guide.model);
        const pin = provider === 'codex' && guide.model !== undefined && listed !== undefined ? guide.model : undefined;
        current = {
          ...current,
          request: pin === undefined ? current.request : { ...current.request, model: pin },
          routing: {
            note: pin === undefined ? (guide.model !== undefined && provider === 'codex' ? `provider default kept: ${guide.model} is not in the Codex model list now` : guide.note) : guide.note,
            evidence: [header, ...strict.evidence, ...guide.lines],
            pinned: pin !== undefined,
            basis: pin === undefined ? 'default' : 'documented-intent',
            uncertainty: pin === undefined ? 'high' : guide.uncertainty,
          },
        };
      }
    } else if (routing === 'research') {
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
        const { evidence, note, applied } = await strictEvidence(step, provider);
        const next: StepRequest = {
          ...current,
          request: applied === undefined ? current.request : { ...current.request, model: applied.model, effort: applied.effort },
          routing: { note, evidence, pinned: applied !== undefined },
        };
        if (applied !== undefined) {
          result[step] = { ...next, policy: { name: policy, note: 'the effort equals the effort the published evidence was measured at, not a separate policy choice' } };
          continue;
        }
        current = next;
      }
    } else if (routing === 'measured') {
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
        const decision = chooseMeasured(deps.outcomes === undefined ? [] : await records(), { provider, step, task: kind, size, ...(group === undefined ? {} : { group }) }, (deps.now ?? (() => new Date()))());
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
      ...(kind === 'sensitive' && (routing === 'adaptive' || routing === 'research' || routing === 'guided') ? { sensitive: true } : {}),
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
