import type { CodexSandbox } from './codex-run.ts';
import type { SelectionProvider, SelectionStep } from './step-selection.ts';

/**
 * What an agent step may do. There is deliberately no unrestricted profile: nothing here maps to
 * `danger-full-access`, `bypassPermissions` or `--dangerously-skip-permissions`.
 *
 * - `text-only`: no tools at all (Claude only; Codex has no such mode).
 * - `read-only`: read the working directory and run a fixed set of read-only inspection commands.
 * - `workspace-write`: additionally edit files inside the isolated, verified Git worktree.
 */
export const PERMISSION_PROFILES = ['text-only', 'read-only', 'workspace-write'] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export function isPermissionProfile(value: string): value is PermissionProfile {
  return (PERMISSION_PROFILES as readonly string[]).includes(value);
}

export const DEFAULT_PROFILE: Readonly<Record<SelectionStep, PermissionProfile>> = {
  plan: 'read-only',
  implement: 'workspace-write',
  review: 'read-only',
};

/** Writing is only ever allowed in the implementation step: the change inspection compares against the state before it. */
export const ALLOWED_PROFILES: Readonly<Record<SelectionStep, readonly PermissionProfile[]>> = {
  plan: ['text-only', 'read-only'],
  implement: ['workspace-write'],
  review: ['text-only', 'read-only'],
};

/** Why a step/provider/profile combination is refused, or `undefined` when it is allowed. */
export function profileProblem(step: SelectionStep, provider: SelectionProvider, profile: PermissionProfile): string | undefined {
  if (!ALLOWED_PROFILES[step].includes(profile)) {
    return `the ${step} step cannot use ${profile} (allowed: ${ALLOWED_PROFILES[step].join(', ')})`;
  }
  if (provider === 'codex' && profile === 'text-only') return 'codex has no text-only mode (its most restricted profile is read-only)';
  return undefined;
}

/** The Codex sandbox a profile maps to; `text-only` has none. */
export function codexSandboxFor(profile: PermissionProfile): CodexSandbox | undefined {
  if (profile === 'workspace-write') return 'workspace-write';
  return profile === 'read-only' ? 'read-only' : undefined;
}
