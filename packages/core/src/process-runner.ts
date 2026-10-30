import { spawn, type ChildProcess } from 'node:child_process';
import { resolveLaunch } from './providers.ts';

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Explicit working directory of the child. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Written to stdin, then stdin is closed. */
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
}

export type ProcessOutcome =
  | { readonly kind: 'completed'; readonly exitCode: number | null; readonly stdout: string; readonly truncated: boolean }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'spawn-failed' };

export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessOutcome>;

const CLOSE_GRACE_MS = 2000;

/** Ends the whole process tree: a process group on POSIX, `taskkill /T` on Windows. */
function killTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined) {
      resolve();
      return;
    }
    if (platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        child.kill();
        resolve();
      });
      killer.on('close', () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    resolve();
  });
}

/**
 * Runs one process without a shell, with a timeout, cancellation, bounded stdout and tree
 * cleanup. stderr is discarded and never surfaced.
 */
export const runProcess: ProcessRunner = (spec) =>
  new Promise((resolve) => {
    const platform = spec.platform ?? process.platform;
    if (spec.signal?.aborted === true) {
      resolve({ kind: 'cancelled' });
      return;
    }
    let launch: ReturnType<typeof resolveLaunch>;
    try {
      launch = resolveLaunch(spec.command, spec.args, { platform, env: spec.env });
    } catch {
      resolve({ kind: 'spawn-failed' });
      return;
    }
    if (launch === undefined) {
      resolve({ kind: 'not-found' });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(launch.file, [...launch.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: platform !== 'win32',
      });
    } catch {
      resolve({ kind: 'spawn-failed' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const handles: { timer?: NodeJS.Timeout } = {};
    let closed = false;
    let onClosed: () => void = () => undefined;

    const cleanup = (): void => {
      if (handles.timer !== undefined) clearTimeout(handles.timer);
      spec.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (outcome: ProcessOutcome, stop: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!stop) {
        resolve(outcome);
        return;
      }
      void killTree(child, platform).then(async () => {
        if (!closed) {
          await new Promise<void>((done) => {
            const wait = setTimeout(done, CLOSE_GRACE_MS);
            onClosed = () => {
              clearTimeout(wait);
              done();
            };
          });
        }
        resolve(outcome);
      });
    };
    function onAbort(): void {
      settle({ kind: 'cancelled' }, true);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (size >= spec.maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = spec.maxOutputBytes - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle({ kind: error.code === 'ENOENT' ? 'not-found' : 'spawn-failed' }, false);
    });
    child.on('close', (exitCode) => {
      closed = true;
      onClosed();
      settle({ kind: 'completed', exitCode, stdout: Buffer.concat(chunks).toString('utf8'), truncated }, false);
    });
    handles.timer = setTimeout(() => {
      settle({ kind: 'timeout' }, true);
    }, Math.max(1, spec.timeoutMs));
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin?.end(spec.input ?? '');
  });
