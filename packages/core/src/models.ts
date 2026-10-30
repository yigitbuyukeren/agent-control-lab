import { withAppServer, type RpcOutcome } from './app-server-client.ts';
import type { AppServerSpawn } from './quota.ts';

export type ModelProviderId = 'claude' | 'codex';

/**
 * A reasoning/effort level name. Ultracode is deliberately NOT an effort: it is an optional
 * working mode (see `WorkMode`), so it can never appear here.
 */
export type EffortLevel = string & { readonly __effort?: never };

const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

export function asEffortLevel(value: unknown): EffortLevel | undefined {
  return typeof value === 'string' && EFFORT_PATTERN.test(value) && value !== 'ultracode'
    ? (value)
    : undefined;
}

/** Optional working modes, independent of effort. */
export type WorkMode = 'ultracode';
export type ModeSupport = 'supported' | 'unsupported' | 'unknown';

/** Where the entry comes from: shipped documentation or live discovery by the provider CLI. */
export type ModelSource = 'documented' | 'discovered';
/**
 * `unverified`: nothing proves this account can use the model.
 * `listed`: the provider CLI listed it for the signed-in account (still not a usage guarantee).
 */
export type AccessStatus = 'unverified' | 'listed';

export type EffortSupport =
  | { readonly status: 'known'; readonly supported: readonly EffortLevel[]; readonly default?: EffortLevel }
  | { readonly status: 'unknown' };

export interface ModelCapability {
  readonly provider: ModelProviderId;
  readonly id: string;
  readonly displayName?: string;
  readonly source: ModelSource;
  readonly access: AccessStatus;
  readonly efforts: EffortSupport;
  readonly modes: Readonly<Record<WorkMode, ModeSupport>>;
}

/** Effort names documented for Claude Code (`low` … `max`); per-model support is not documented. */
export const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const UNKNOWN_MODES = { ultracode: 'unknown' } as const;

function claudeModel(id: string, displayName: string): ModelCapability {
  return {
    provider: 'claude',
    id,
    displayName,
    source: 'documented',
    access: 'unverified',
    efforts: { status: 'unknown' },
    modes: UNKNOWN_MODES,
  };
}

/** Starting registry: documented model IDs only. It never claims account access. */
export const claudeRegistry: readonly ModelCapability[] = [
  claudeModel('claude-fable-5-1', 'Fable 5.1'),
  claudeModel('claude-opus-5-5', 'Opus 5.5'),
  claudeModel('claude-sonnet-5-5', 'Sonnet 5.5'),
  claudeModel('claude-haiku-5-5', 'Haiku 5.5'),
];

export type CodexModelsResult =
  | { readonly state: 'ok'; readonly models: readonly ModelCapability[] }
  | { readonly state: 'not-installed' }
  | { readonly state: 'error'; readonly error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keeps only id, display name, supported efforts and default effort; everything else is dropped. */
export function parseCodexModel(value: unknown): ModelCapability | undefined {
  const record = asRecord(value);
  const rawId = record?.['model'] ?? record?.['id'];
  if (record === undefined || typeof rawId !== 'string' || rawId === '' || rawId.length > 128) return undefined;
  const options = record['supportedReasoningEfforts'];
  let efforts: EffortSupport = { status: 'unknown' };
  if (Array.isArray(options)) {
    const supported = options.flatMap((option) => {
      const level = asEffortLevel(asRecord(option)?.['reasoningEffort']);
      return level === undefined ? [] : [level];
    });
    const fallback = asEffortLevel(record['defaultReasoningEffort']);
    if (supported.length > 0) {
      efforts = {
        status: 'known',
        supported: [...new Set(supported)],
        ...(fallback !== undefined && supported.includes(fallback) ? { default: fallback } : {}),
      };
    }
  }
  const displayName = record['displayName'];
  return {
    provider: 'codex',
    id: rawId,
    ...(typeof displayName === 'string' && displayName !== '' && displayName.length <= 128 ? { displayName } : {}),
    source: 'discovered',
    access: 'listed',
    efforts,
    modes: { ultracode: 'unsupported' },
  };
}

const MAX_PAGES = 50;
const PAGE_SIZE = 100;

/** Read-only discovery through `codex app-server` `model/list`, following every page. */
export async function discoverCodexModels(
  spawnServer?: AppServerSpawn,
  timeoutMs?: number,
): Promise<CodexModelsResult> {
  const outcome: RpcOutcome<ModelCapability[]> = await withAppServer(
    async (request) => {
      const byId = new Map<string, ModelCapability>();
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = asRecord(
          await request('model/list', { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }),
        );
        const data = result?.['data'];
        if (Array.isArray(data)) {
          for (const item of data) {
            const model = parseCodexModel(item);
            if (model !== undefined && !byId.has(model.id)) byId.set(model.id, model);
          }
        }
        const next = result?.['nextCursor'];
        if (typeof next !== 'string' || next === '' || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      return [...byId.values()];
    },
    spawnServer,
    timeoutMs,
  );
  if (outcome.kind === 'ok') return { state: 'ok', models: outcome.value };
  return outcome.kind === 'not-installed' ? { state: 'not-installed' } : { state: 'error', error: outcome.error };
}

/**
 * `supported`/`unsupported` are only answered from known data. `unknown` means we cannot say:
 * the model is not in the registry, or its efforts were never documented or discovered.
 */
export type EffortCheck =
  | { readonly status: 'supported'; readonly isDefault: boolean }
  | { readonly status: 'unsupported'; readonly supported: readonly EffortLevel[] }
  | { readonly status: 'unknown'; readonly reason: 'model-not-listed' | 'efforts-not-known' | 'invalid-effort' };

export function checkEffort(
  registry: readonly ModelCapability[],
  provider: ModelProviderId,
  modelId: string,
  effort: string,
): EffortCheck {
  const level = asEffortLevel(effort);
  // `ultracode` (or any malformed name) is never a valid effort, but that is not a model fact.
  if (level === undefined) return { status: 'unknown', reason: 'invalid-effort' };
  const model = registry.find((m) => m.provider === provider && m.id === modelId);
  if (model === undefined) return { status: 'unknown', reason: 'model-not-listed' };
  if (model.efforts.status === 'known') {
    return model.efforts.supported.includes(level)
      ? { status: 'supported', isDefault: model.efforts.default === level }
      : { status: 'unsupported', supported: model.efforts.supported };
  }
  // Efforts unknown for this model: a level outside the provider's documented vocabulary is
  // still definitely unsupported.
  if (provider === 'claude' && !CLAUDE_EFFORT_LEVELS.includes(level)) {
    return { status: 'unsupported', supported: CLAUDE_EFFORT_LEVELS };
  }
  return { status: 'unknown', reason: 'efforts-not-known' };
}
