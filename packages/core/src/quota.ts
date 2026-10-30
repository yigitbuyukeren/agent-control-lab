import { spawn } from 'node:child_process';
import { VERSION } from '@agent-control-lab/shared';
import { resolveLaunch, type ExecOptions } from './providers.ts';

export interface QuotaWindow {
  /** Percent of the window already used; undefined when the server did not say. */
  readonly usedPercent?: number;
  readonly windowMinutes?: number;
  /** ISO 8601 UTC time the window resets. */
  readonly resetsAt?: string;
}

export interface QuotaStatus {
  readonly state: 'ok' | 'not-installed' | 'error';
  readonly plan?: string;
  readonly primary?: QuotaWindow;
  readonly secondary?: QuotaWindow;
  readonly error?: string;
}

export interface AppServerExit {
  readonly notFound: boolean;
}

/** A started `codex app-server` speaking JSONL on stdio. */
export interface AppServerProcess {
  send(line: string): void;
  onLine(callback: (line: string) => void): void;
  onExit(callback: (exit: AppServerExit) => void): void;
  /** Stops the process (and its tree on Windows); resolves once the stop was issued. */
  kill(): Promise<void>;
}

export type AppServerSpawn = (command: string, args: readonly string[]) => AppServerProcess;

export const QUOTA_TIMEOUT_MS = 10_000;

/** Fixed messages only: raw server output or errors may carry identity details. */
const ERR_TIMEOUT = 'timed out';
const ERR_EXITED = 'app-server exited before replying';
const ERR_REQUEST = 'quota request was rejected';

const KNOWN_PLANS: ReadonlySet<string> = new Set([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'promax',
  'team',
  'business',
  'enterprise',
  'edu',
]);

export function createAppServerSpawn(options: ExecOptions = {}): AppServerSpawn {
  const env = options.env ?? process.env;
  return (command, args) => {
    const launch = resolveLaunch(command, args, options);
    const lineCallbacks: ((line: string) => void)[] = [];
    const exitCallbacks: ((exit: AppServerExit) => void)[] = [];
    let exited = false;
    const emitExit = (exit: AppServerExit): void => {
      if (exited) return;
      exited = true;
      exitCallbacks.forEach((callback) => {
        callback(exit);
      });
    };
    if (launch === undefined) {
      queueMicrotask(() => {
        emitExit({ notFound: true });
      });
      return {
        send: () => undefined,
        onLine: (callback) => lineCallbacks.push(callback),
        onExit: (callback) => exitCallbacks.push(callback),
        kill: () => Promise.resolve(),
      };
    }
    const child = spawn(launch.file, [...launch.args], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') lineCallbacks.forEach((callback) => { callback(line); });
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > 1024 * 1024) buffer = '';
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      emitExit({ notFound: error.code === 'ENOENT' });
    });
    child.on('close', () => {
      emitExit({ notFound: false });
    });
    return {
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
      onLine: (callback) => lineCallbacks.push(callback),
      onExit: (callback) => exitCallbacks.push(callback),
      kill: () =>
        new Promise<void>((resolve) => {
          child.stdin.end();
          const pid = child.pid;
          if (process.platform === 'win32' && pid !== undefined) {
            // The shim runs under cmd.exe, so end the whole tree.
            const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            killer.on('error', () => {
              child.kill();
              resolve();
            });
            killer.on('close', () => {
              resolve();
            });
          } else {
            child.kill('SIGKILL');
            resolve();
          }
        }),
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseWindow(value: unknown): QuotaWindow | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const used = record['usedPercent'];
  const minutes = record['windowDurationMins'];
  const resets = record['resetsAt'];
  const window: { usedPercent?: number; windowMinutes?: number; resetsAt?: string } = {};
  if (typeof used === 'number' && Number.isFinite(used)) {
    window.usedPercent = Math.min(100, Math.max(0, used));
  }
  if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0) {
    window.windowMinutes = minutes;
  }
  if (typeof resets === 'number' && Number.isFinite(resets) && resets > 0) {
    const date = new Date(resets * 1000);
    if (!Number.isNaN(date.getTime())) window.resetsAt = date.toISOString();
  }
  return window;
}

/** Keeps only plan, percentages, window length and reset time; drops every other field. */
export function parseRateLimits(result: unknown): QuotaStatus {
  const record = asRecord(result);
  const byId = asRecord(record?.['rateLimitsByLimitId']);
  const snapshot = asRecord(byId?.['codex']) ?? asRecord(record?.['rateLimits']);
  if (snapshot === undefined) return { state: 'ok' };
  const plan = snapshot['planType'];
  const primary = parseWindow(snapshot['primary']);
  const secondary = parseWindow(snapshot['secondary']);
  return {
    state: 'ok',
    ...(typeof plan === 'string' && KNOWN_PLANS.has(plan) ? { plan } : {}),
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
  };
}

/**
 * Read-only handshake with `codex app-server`: initialize, initialized, then
 * `account/rateLimits/read`. No model calls. The process is always stopped afterwards.
 */
export async function readCodexQuota(
  spawnServer: AppServerSpawn = createAppServerSpawn(),
  timeoutMs: number = QUOTA_TIMEOUT_MS,
): Promise<QuotaStatus> {
  const proc = spawnServer('codex', ['app-server']);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<QuotaStatus>((resolve) => {
      timer = setTimeout(() => {
        resolve({ state: 'error', error: ERR_TIMEOUT });
      }, Math.max(1, timeoutMs));
      proc.onExit(({ notFound }) => {
        resolve(notFound ? { state: 'not-installed' } : { state: 'error', error: ERR_EXITED });
      });
      proc.onLine((line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        const record = asRecord(message);
        if (record === undefined || 'method' in record) return;
        if (record['id'] === 1 && 'result' in record) {
          proc.send(JSON.stringify({ method: 'initialized' }));
          proc.send(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }));
        } else if (record['id'] === 2) {
          resolve('result' in record ? parseRateLimits(record['result']) : { state: 'error', error: ERR_REQUEST });
        } else if ('error' in record && record['id'] === 1) {
          resolve({ state: 'error', error: ERR_REQUEST });
        }
      });
      proc.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'agent-control-lab', title: null, version: VERSION } },
        }),
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await proc.kill();
  }
}

