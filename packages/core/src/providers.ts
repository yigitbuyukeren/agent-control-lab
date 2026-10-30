import { execFile } from 'node:child_process';

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

/**
 * Runs a fixed command with a timeout and no stdin. On Windows npm-installed CLIs are
 * `.cmd` shims, which `execFile` cannot start without a shell; command names and args
 * come only from adapters, never from user input.
 */
export const defaultExec: Exec = (command, args, { timeoutMs }) =>
  new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const child = execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        shell: windows,
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
        } else if (windows && (code === 1 || code === 9009)) {
          // cmd.exe reports an unknown command this way.
          resolve({ kind: 'not-found' });
        } else {
          resolve({ kind: 'failed', detail: error.message.split('\n')[0] ?? 'unknown error' });
        }
      },
    );
    child.stdin?.end();
  });

export interface ProviderStatus {
  readonly id: string;
  readonly displayName: string;
  readonly installed: boolean;
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
    return { ...base, installed: false, error: detail };
  }
  switch (result.kind) {
    case 'ok': {
      const version = parseVersion(result.stdout);
      return version === undefined ? { ...base, installed: true } : { ...base, installed: true, version };
    }
    case 'not-found':
      return { ...base, installed: false };
    case 'timeout':
      return { ...base, installed: false, error: `timed out after ${String(timeoutMs)} ms` };
    case 'failed':
      return { ...base, installed: false, error: result.detail };
  }
}

export function detectProviders(
  adapters: readonly ProviderAdapter[] = builtinAdapters,
  exec: Exec = defaultExec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProviderStatus[]> {
  return Promise.all(adapters.map((adapter) => detectProvider(adapter, exec, timeoutMs)));
}
