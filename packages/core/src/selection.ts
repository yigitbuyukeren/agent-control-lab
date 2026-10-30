import { CLAUDE_EFFORT_LEVELS, asEffortLevel, checkEffort, type CodexModelsResult, type ModelCapability, type ModeSupport } from './models.ts';
import type { RouteProvider } from './routing.ts';

export type ModeRequest = 'normal' | 'ultracode';

/**
 * What the user asked for. `auto` never guesses: it keeps the provider's own default.
 * There is deliberately no `auto` mode: ultracode is only ever chosen by explicit request.
 */
export interface SelectionRequest {
  /** `auto` or a model id. */
  readonly model: string;
  /** `auto` or an effort level name. */
  readonly effort: string;
  readonly mode: ModeRequest;
}

export const DEFAULT_REQUEST: SelectionRequest = { model: 'auto', effort: 'auto', mode: 'normal' };

export function isDefaultRequest(request: SelectionRequest): boolean {
  return request.model === 'auto' && request.effort === 'auto' && request.mode === 'normal';
}

export interface ModelCatalog {
  readonly claude: readonly ModelCapability[];
  readonly codex: CodexModelsResult;
}

export type EffortUnverifiedReason =
  | 'efforts-not-known'
  | 'model-not-verified'
  | 'default-model-unknown'
  | 'catalog-unavailable';

/** Blocking issues are definite incompatibilities; the others only lack verification. */
export type SelectionIssue =
  | { readonly code: 'model-not-listed'; readonly blocking: true; readonly model: string }
  | {
      readonly code: 'model-discovery-failed';
      readonly blocking: false;
      readonly model: string;
      readonly reason: 'not-installed' | 'error';
      readonly error?: string;
    }
  | { readonly code: 'model-access-unverified'; readonly blocking: false; readonly model: string; readonly documented: boolean }
  | { readonly code: 'effort-invalid'; readonly blocking: true; readonly effort: string }
  | {
      readonly code: 'effort-unsupported';
      readonly blocking: true;
      readonly effort: string;
      readonly supported: readonly string[];
    }
  | {
      readonly code: 'effort-unverified';
      readonly blocking: false;
      readonly effort: string;
      readonly reason: EffortUnverifiedReason;
    }
  | { readonly code: 'mode-unsupported'; readonly blocking: true; readonly mode: 'ultracode' }
  | { readonly code: 'mode-unverified'; readonly blocking: false; readonly mode: 'ultracode' };

export type Pinned =
  | { readonly kind: 'provider-default' }
  | { readonly kind: 'explicit'; readonly value: string; readonly verified: boolean };

export interface Selection {
  readonly provider: RouteProvider;
  readonly model: Pinned;
  readonly effort: Pinned;
  readonly mode: ModeRequest;
  readonly issues: readonly SelectionIssue[];
  /** True when anything could not be verified or is incompatible: nothing proceeds silently. */
  readonly manualApprovalRequired: boolean;
  readonly blocked: boolean;
}

const PROVIDER_DEFAULT: Pinned = { kind: 'provider-default' };

function modeSupport(model: ModelCapability | undefined): ModeSupport {
  return model?.modes.ultracode ?? 'unknown';
}

/** Validates model, effort and mode for an already-chosen provider. Never changes the provider. */
export function resolveSelection(
  provider: RouteProvider,
  request: SelectionRequest,
  catalog: ModelCatalog,
): Selection {
  const issues: SelectionIssue[] = [];
  const registry: readonly ModelCapability[] =
    provider === 'claude' ? catalog.claude : catalog.codex.state === 'ok' ? catalog.codex.models : [];
  const codexCatalog = provider === 'codex' ? catalog.codex : undefined;
  const catalogDown = codexCatalog !== undefined && codexCatalog.state !== 'ok';

  // Model
  let model: Pinned = PROVIDER_DEFAULT;
  let modelCapability: ModelCapability | undefined;
  let modelVerified = false;
  if (request.model !== 'auto') {
    modelCapability = registry.find((m) => m.id === request.model);
    if (provider === 'claude') {
      issues.push({
        code: 'model-access-unverified',
        blocking: false,
        model: request.model,
        documented: modelCapability !== undefined,
      });
    } else if (codexCatalog?.state === 'ok') {
      if (modelCapability === undefined) {
        issues.push({ code: 'model-not-listed', blocking: true, model: request.model });
      } else {
        modelVerified = true;
      }
    } else if (codexCatalog !== undefined) {
      // Discovery itself failed: that is not the same as the model being absent.
      issues.push({
        code: 'model-discovery-failed',
        blocking: false,
        model: request.model,
        reason: codexCatalog.state === 'not-installed' ? 'not-installed' : 'error',
        ...(codexCatalog.state === 'error' ? { error: codexCatalog.error } : {}),
      });
    }
    model = { kind: 'explicit', value: request.model, verified: modelVerified };
  }

  // Effort
  let effort: Pinned = PROVIDER_DEFAULT;
  if (request.effort !== 'auto') {
    let verified = false;
    const level = asEffortLevel(request.effort);
    if (level === undefined) {
      issues.push({ code: 'effort-invalid', blocking: true, effort: request.effort });
    } else if (request.model === 'auto') {
      if (provider === 'claude' && !CLAUDE_EFFORT_LEVELS.includes(level)) {
        issues.push({ code: 'effort-unsupported', blocking: true, effort: level, supported: CLAUDE_EFFORT_LEVELS });
      } else {
        // The provider default model may be changed by the user's own config, so it is not assumed.
        issues.push({ code: 'effort-unverified', blocking: false, effort: level, reason: 'default-model-unknown' });
      }
    } else if (catalogDown) {
      issues.push({ code: 'effort-unverified', blocking: false, effort: level, reason: 'catalog-unavailable' });
    } else {
      const check = checkEffort(registry, provider, request.model, level);
      if (check.status === 'supported') {
        verified = true;
      } else if (check.status === 'unsupported') {
        issues.push({ code: 'effort-unsupported', blocking: true, effort: level, supported: check.supported });
      } else if (check.reason === 'invalid-effort') {
        issues.push({ code: 'effort-invalid', blocking: true, effort: level });
      } else if (check.reason === 'efforts-not-known') {
        issues.push({ code: 'effort-unverified', blocking: false, effort: level, reason: 'efforts-not-known' });
      } else if (!issues.some((i) => i.code === 'model-not-listed')) {
        issues.push({ code: 'effort-unverified', blocking: false, effort: level, reason: 'model-not-verified' });
      }
    }
    effort = { kind: 'explicit', value: request.effort, verified };
  }

  // Mode: ultracode is a separate, explicit-only working mode, never an effort.
  if (request.mode === 'ultracode') {
    // Codex has no ultracode mode at all: that is a definite incompatibility, not an unknown.
    const support: ModeSupport = provider === 'codex' ? 'unsupported' : modeSupport(modelCapability);
    issues.push(
      support === 'unsupported'
        ? { code: 'mode-unsupported', blocking: true, mode: 'ultracode' }
        : { code: 'mode-unverified', blocking: false, mode: 'ultracode' },
    );
  }

  return {
    provider,
    model,
    effort,
    mode: request.mode,
    issues,
    manualApprovalRequired: issues.length > 0,
    blocked: issues.some((i) => i.blocking),
  };
}

