import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Executable name looked up on PATH. */
  readonly command: string;
  readonly versionArgs: readonly string[];
}

export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
};

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  versionArgs: ['--version'],
};

export const builtinAdapters: readonly ProviderAdapter[] = [claudeCodeAdapter, codexAdapter];

export type ExecResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly detail: string };

export type Exec = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 5000;

const MAX_OUTPUT_BYTES = 64 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Finds `command` on PATH the way cmd.exe does (PATH order, then PATHEXT extensions). */
export function resolveWindowsExecutable(
  command: string,
  env: Env,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  const dirs = (envValue(env, 'PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '');
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = win32.join(dir, command + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface ExecOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Env;
  readonly exists?: (path: string) => boolean;
}

/**
 * Builds an Exec that runs a fixed command with a timeout and no stdin. On Windows the
 * command is resolved on PATH first (so "not installed" never depends on an exit code);
 * `.cmd`/`.bat` shims, which npm-installed CLIs use, run through cmd.exe. Command names
 * and args come only from adapters, never from user input.
 */
export function createExec(options: ExecOptions = {}): Exec {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return (command, args, { timeoutMs }) =>
    new Promise((resolve) => {
      let file = command;
      let fileArgs = [...args];
      let verbatim = false;
      if (platform === 'win32') {
        const resolved = resolveWindowsExecutable(command, env, options.exists);
        if (resolved === undefined) {
          resolve({ kind: 'not-found' });
          return;
        }
        const ext = win32.extname(resolved).toLowerCase();
        if (ext === '.cmd' || ext === '.bat') {
          file = envValue(env, 'ComSpec') ?? 'cmd.exe';
          fileArgs = ['/d', '/s', '/c', `""${resolved}" ${args.join(' ')}"`];
          verbatim = true;
        } else {
          file = resolved;
        }
      }
      const child = execFile(
        file,
        fileArgs,
        {
          env: { ...env },
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error === null) {
            resolve({ kind: 'ok', stdout });
            return;
          }
          const code: unknown = (error as { code?: unknown }).code;
          if (code === 'ENOENT') {
            resolve({ kind: 'not-found' });
          } else if ((error as { killed?: boolean }).killed === true) {
            resolve({ kind: 'timeout' });
          } else {
            resolve({ kind: 'failed', detail: error.message.split('\n')[0] ?? 'unknown error' });
          }
        },
      );
      child.stdin?.end();
    });
}

export const defaultExec: Exec = createExec();

export type ProviderState = 'installed' | 'not-found' | 'error';

export interface ProviderStatus {
  readonly id: string;
  readonly displayName: string;
  /** `error` means the check itself failed, so installation is unknown. */
  readonly state: ProviderState;
  readonly version?: string;
  readonly error?: string;
}

const VERSION_PATTERN = /\d+\.\d+\.\d+[\w.+-]*/;

export function parseVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[0];
}

export async function detectProvider(
  adapter: ProviderAdapter,
  exec: Exec = defaultExec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProviderStatus> {
  const base = { id: adapter.id, displayName: adapter.displayName };
  let result: ExecResult;
  try {
    result = await exec(adapter.command, adapter.versionArgs, { timeoutMs });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ...base, state: 'error', error: detail };
  }
  switch (result.kind) {
    case 'ok': {
      const version = parseVersion(result.stdout);
      return version === undefined ? { ...base, state: 'installed' } : { ...base, state: 'installed', version };
    }
    case 'not-found':
      return { ...base, state: 'not-found' };
    case 'timeout':
      return { ...base, state: 'error', error: `timed out after ${String(timeoutMs)} ms` };
    case 'failed':
      return { ...base, state: 'error', error: result.detail };
  }
}

export function detectProviders(
  adapters: readonly ProviderAdapter[] = builtinAdapters,
  exec: Exec = defaultExec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProviderStatus[]> {
  return Promise.all(adapters.map((adapter) => detectProvider(adapter, exec, timeoutMs)));
}
