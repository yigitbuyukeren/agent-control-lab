import type { Exec, ProviderAdapter } from './providers.ts';
import { DEFAULT_TIMEOUT_MS, defaultExec } from './providers.ts';

export type AuthState = 'logged-in' | 'logged-out' | 'unknown' | 'not-installed' | 'error';
export type AuthMethod = 'subscription' | 'api-key' | 'unknown';

export interface AuthOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type ParsedAuth =
  | { readonly state: 'logged-in'; readonly method: AuthMethod; readonly plan?: string }
  | { readonly state: 'logged-out' }
  | { readonly state: 'unknown' };

export interface AuthProbe {
  readonly args: readonly string[];
  /** Must return only whitelisted, non-sensitive facts; never raw output. */
  readonly parse: (output: AuthOutput) => ParsedAuth;
}

/** Only these fields ever leave a status: no tokens, emails or raw output. */
export interface AuthStatus {
  readonly id: string;
  readonly displayName: string;
  readonly state: AuthState;
  readonly method?: AuthMethod;
  readonly plan?: string;
  readonly error?: string;
}

const UNKNOWN: ParsedAuth = { state: 'unknown' };
const PLAN_PATTERN = /^[\w-]{1,24}$/;

/** `claude auth status` prints JSON with `loggedIn`, `authMethod`, `subscriptionType`. */
export function parseClaudeAuth({ stdout }: AuthOutput): ParsedAuth {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return UNKNOWN;
  }
  if (typeof data !== 'object' || data === null) return UNKNOWN;
  const record = data as Record<string, unknown>;
  if (record['loggedIn'] === false) return { state: 'logged-out' };
  if (record['loggedIn'] !== true) return UNKNOWN;
  const authMethod = record['authMethod'];
  if (authMethod === 'claude.ai') {
    const plan = record['subscriptionType'];
    return typeof plan === 'string' && PLAN_PATTERN.test(plan)
      ? { state: 'logged-in', method: 'subscription', plan }
      : { state: 'logged-in', method: 'subscription' };
  }
  if (typeof authMethod === 'string' && /api[_ -]?key/i.test(authMethod)) {
    return { state: 'logged-in', method: 'api-key' };
  }
  return { state: 'logged-in', method: 'unknown' };
}

/** `codex login status` prints one line such as "Logged in using ChatGPT". */
export function parseCodexAuth({ stdout, stderr }: AuthOutput): ParsedAuth {
  const text = `${stdout}\n${stderr}`;
  if (/^\s*Not logged in/im.test(text)) return { state: 'logged-out' };
  if (/^\s*Logged in using ChatGPT/im.test(text)) return { state: 'logged-in', method: 'subscription' };
  if (/^\s*Logged in using an API key/im.test(text)) return { state: 'logged-in', method: 'api-key' };
  return UNKNOWN;
}

function fromParsed(base: { id: string; displayName: string }, parsed: ParsedAuth): AuthStatus {
  if (parsed.state !== 'logged-in') return { ...base, state: parsed.state };
  return parsed.plan === undefined
    ? { ...base, state: 'logged-in', method: parsed.method }
    : { ...base, state: 'logged-in', method: parsed.method, plan: parsed.plan };
}

export async function detectAuth(
  adapter: ProviderAdapter,
  exec: Exec = defaultExec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AuthStatus> {
  const base = { id: adapter.id, displayName: adapter.displayName };
  const probe = adapter.auth;
  if (probe === undefined) return { ...base, state: 'unknown' };
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await exec(adapter.command, probe.args, { timeoutMs });
  } catch (cause) {
    return { ...base, state: 'error', error: cause instanceof Error ? cause.message : String(cause) };
  }
  switch (result.kind) {
    case 'ok':
      return fromParsed(base, probe.parse({ stdout: result.stdout, stderr: result.stderr ?? '' }));
    case 'not-found':
      return { ...base, state: 'not-installed' };
    case 'timeout':
      return { ...base, state: 'error', error: `timed out after ${String(timeoutMs)} ms` };
    case 'failed': {
      // Logged-out CLIs commonly exit non-zero, so a recognised output still counts.
      const parsed = probe.parse({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
      return parsed.state === 'unknown'
        ? { ...base, state: 'error', error: result.detail }
        : fromParsed(base, parsed);
    }
  }
}

export function detectAuthStatuses(
  adapters: readonly ProviderAdapter[],
  exec: Exec = defaultExec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AuthStatus[]> {
  return Promise.all(adapters.map((adapter) => detectAuth(adapter, exec, timeoutMs)));
}
