import { runClaude, type ClaudeRunDeps } from './claude-run.ts';
import { runCodex, type CodexRunDeps } from './codex-run.ts';
import type { StepOutcome } from './orchestration.ts';
import { codexSandboxFor, type PermissionProfile } from './permission-profile.ts';
import type { Selection } from './selection.ts';
import type { SelectionProvider } from './step-selection.ts';

export interface AgentRequest {
  readonly provider: SelectionProvider;
  readonly profile: PermissionProfile;
  readonly prompt: string;
  /** Explicit, already validated working directory (the verified worktree for `workspace-write`). */
  readonly cwd: string;
  readonly selection: Selection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type AgentDeps = ClaudeRunDeps & CodexRunDeps;

/** One entry point for every provider and permission profile; an impossible combination fails closed. */
export async function runAgent(request: AgentRequest, deps: AgentDeps = {}): Promise<StepOutcome> {
  const signal = request.signal === undefined ? {} : { signal: request.signal };
  if (request.provider === 'claude') {
    return runClaude(
      { task: request.prompt, cwd: request.cwd, selection: request.selection, timeoutMs: request.timeoutMs, policy: { profile: request.profile }, ...signal },
      deps,
    );
  }
  const sandbox = codexSandboxFor(request.profile);
  if (sandbox === undefined) return { kind: 'failed' };
  return runCodex({ task: request.prompt, cwd: request.cwd, selection: request.selection, timeoutMs: request.timeoutMs, sandbox, ...signal }, deps);
}
