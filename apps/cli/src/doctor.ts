import { builtinAdapters, defaultExec, detectAuthStatuses, detectProviders, resolveSandbox, type Exec, type SandboxDecision } from '@agent-control-lab/core';
import { access, constants, mkdir } from 'node:fs/promises';

export interface DoctorCheck {
  readonly id: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly message: string;
  /** What to do about it, in plain words. */
  readonly fix?: string;
}

export interface DoctorDeps {
  readonly exec?: Exec;
  readonly sandbox?: SandboxDecision;
  readonly cacheDir?: string | undefined;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
}

const INSTALL: Record<string, string> = {
  claude: 'Install Claude Code from https://docs.claude.com/claude-code and run `claude` once to sign in with your Pro/Max account.',
  codex: 'Install the Codex CLI (`npm install -g @openai/codex`) and run `codex login` with your ChatGPT account.',
};

/** First-run diagnosis: read-only, calls no model and changes nothing. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const major = Number((deps.nodeVersion ?? process.version).replace(/^v/, '').split('.')[0]);
  checks.push(major >= 24 ? { id: 'node', status: 'ok', message: `Node.js ${deps.nodeVersion ?? process.version}` } : { id: 'node', status: 'fail', message: `Node.js ${deps.nodeVersion ?? process.version} is too old; 24 or newer is required`, fix: 'Install Node.js 24 or newer from https://nodejs.org.' });

  const git = await exec('git', ['--version'], { timeoutMs: 5000 }).catch(() => undefined);
  checks.push(git?.kind === 'ok' ? { id: 'git', status: 'ok', message: git.stdout.trim() } : { id: 'git', status: 'fail', message: 'git was not found', fix: 'Install Git; worktrees, diffs and the safety checks need it.' });

  const providers = await detectProviders(undefined, exec);
  const auth = await detectAuthStatuses(builtinAdapters, exec);
  for (const p of providers) {
    const id = p.displayName.toLowerCase();
    const a = auth.find((x) => x.displayName === p.displayName);
    if (p.state === 'not-found') checks.push({ id, status: 'warn', message: `${p.displayName} is not installed (optional: you can work with only the other agent)`, fix: INSTALL[id] ?? 'Install the CLI.' });
    else if (p.state === 'error') checks.push({ id, status: 'fail', message: `${p.displayName} did not answer --version`, fix: 'Run it once in a terminal to see the problem.' });
    else if (a?.state === 'logged-in') checks.push({ id, status: 'ok', message: `${p.displayName} ${p.version ?? ''} installed and signed in${a.method === undefined || a.method === 'unknown' ? '' : ` (${a.method})`}`.replace('  ', ' ') });
    else checks.push({ id, status: 'warn', message: `${p.displayName} is installed but not signed in${a?.state === 'unknown' ? ' (state unknown)' : ''}`, fix: id === 'codex' ? 'Run `codex login`.' : 'Run `claude` once and sign in with your subscription.' });
  }
  if (!providers.some((p) => p.state === 'installed')) checks.push({ id: 'agents', status: 'fail', message: 'neither Claude Code nor Codex is installed', fix: 'Install at least one of them.' });

  const sandbox = deps.sandbox ?? (await resolveSandbox());
  checks.push(
    sandbox.mode === 'sandboxed'
      ? { id: 'sandbox', status: 'ok', message: `${sandbox.provider.name} works here (checked just now): the optional test command can run with writes limited to the worktree, no network and credential folders unreadable` }
      : { id: 'sandbox', status: 'warn', message: `no working OS sandbox: ${sandbox.reason}`, fix: platform === 'win32' ? 'Use WSL2 with bubblewrap, or run tests yourself; the tool refuses to run the test command without a sandbox unless you choose the explicit unsandboxed option.' : platform === 'linux' ? 'Install bubblewrap (`apt install bubblewrap`); some distributions restrict unprivileged user namespaces.' : 'The test command stays refused unless you choose the explicit unsandboxed option.' },
  );

  if (deps.cacheDir === undefined) checks.push({ id: 'data', status: 'warn', message: 'no local data directory could be determined: task history and routing records are off', fix: 'Set ACL_CACHE_DIR to a writable folder.' });
  else {
    const writable = await mkdir(deps.cacheDir, { recursive: true, mode: 0o700 }).then(() => access(deps.cacheDir ?? '', constants.W_OK)).then(() => true, () => false);
    checks.push(writable ? { id: 'data', status: 'ok', message: `local data directory ${deps.cacheDir}` } : { id: 'data', status: 'warn', message: `local data directory ${deps.cacheDir} is not writable`, fix: 'Fix its permissions or set ACL_CACHE_DIR.' });
  }
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  return `${checks.map((c) => `${mark[c.status]} ${c.message}${c.fix === undefined ? '' : `\n     -> ${c.fix}`}`).join('\n')}\n`;
}
