import { VERSION } from '@agent-control-lab/shared';
import { createAppServerSpawn, type AppServerSpawn } from './quota.ts';

export type RpcOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'error'; readonly error: string };

export type RpcRequest = (method: string, params?: unknown) => Promise<unknown>;

/** Fixed messages only: raw server output or errors may carry identity details. */
const ERR_TIMEOUT = 'timed out';
const ERR_EXITED = 'app-server exited before replying';
const ERR_REJECTED = 'request was rejected';

class RpcAbort extends Error {
  readonly outcome: RpcOutcome<never>;
  constructor(outcome: RpcOutcome<never>) {
    super('rpc aborted');
    this.outcome = outcome;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Runs read-only requests against `codex app-server` (initialize → initialized → requests)
 * under one overall timeout. The process is always stopped afterwards.
 */
export async function withAppServer<T>(
  run: (request: RpcRequest) => Promise<T>,
  spawnServer: AppServerSpawn = createAppServerSpawn(),
  timeoutMs = 10_000,
): Promise<RpcOutcome<T>> {
  const proc = spawnServer('codex', ['app-server']);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let timer: NodeJS.Timeout | undefined;
  const abortAll = (outcome: RpcOutcome<never>): void => {
    for (const entry of pending.values()) entry.reject(new RpcAbort(outcome));
    pending.clear();
  };
  const request: RpcRequest = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      proc.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    });
  proc.onLine((line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const record = asRecord(message);
    if (record === undefined || 'method' in record || typeof record['id'] !== 'number') return;
    const entry = pending.get(record['id']);
    if (entry === undefined) return;
    pending.delete(record['id']);
    if ('result' in record) entry.resolve(record['result']);
    else entry.reject(new RpcAbort({ kind: 'error', error: ERR_REJECTED }));
  });
  proc.onExit(({ notFound }) => {
    abortAll(notFound ? { kind: 'not-installed' } : { kind: 'error', error: ERR_EXITED });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortAll({ kind: 'error', error: ERR_TIMEOUT });
      reject(new RpcAbort({ kind: 'error', error: ERR_TIMEOUT }));
    }, Math.max(1, timeoutMs));
  });
  try {
    const value = await Promise.race([
      (async () => {
        await request('initialize', { clientInfo: { name: 'agent-control-lab', title: null, version: VERSION } });
        proc.send(JSON.stringify({ method: 'initialized' }));
        return run(request);
      })(),
      timeout,
    ]);
    return { kind: 'ok', value };
  } catch (cause) {
    if (cause instanceof RpcAbort) return cause.outcome;
    return { kind: 'error', error: ERR_REJECTED };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await proc.kill();
  }
}
