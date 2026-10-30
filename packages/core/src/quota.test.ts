import { describe, expect, it } from 'vitest';
import {
  parseRateLimits,
  readCodexQuota,
  type AppServerExit,
  type AppServerProcess,
  type AppServerSpawn,
} from './quota.ts';

type Reply = (message: Record<string, unknown>, emit: (message: unknown) => void) => void;

/** Scripted app-server: records what the client sent and answers via `reply`. */
function fakeServer(reply: Reply) {
  const sent: Record<string, unknown>[] = [];
  const state = { killed: 0, spawned: [] as unknown[] };
  let lineCb: (line: string) => void = () => undefined;
  let exitCb: (exit: AppServerExit) => void = () => undefined;
  const emit = (message: unknown): void => {
    queueMicrotask(() => {
      lineCb(typeof message === 'string' ? message : JSON.stringify(message));
    });
  };
  const proc: AppServerProcess = {
    send(line) {
      const message = JSON.parse(line) as Record<string, unknown>;
      sent.push(message);
      reply(message, emit);
    },
    onLine: (cb) => (lineCb = cb),
    onExit: (cb) => (exitCb = cb),
    kill: () => {
      state.killed += 1;
      return Promise.resolve();
    },
  };
  const spawnServer: AppServerSpawn = (command, args) => {
    state.spawned.push([command, args]);
    return proc;
  };
  return { spawnServer, sent, state, exit: (e: AppServerExit) => { exitCb(e); } };
}

const LIMITS = {
  rateLimits: {
    accountId: 'acct-secret',
    planType: 'pro',
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
  },
};

const happy: Reply = (message, emit) => {
  if (message['id'] === 1) emit({ id: 1, result: { userAgent: 'x' } });
  if (message['id'] === 2) emit({ id: 2, result: LIMITS });
};

describe('readCodexQuota', () => {
  it('performs initialize → initialized → account/rateLimits/read and parses the result', async () => {
    const server = fakeServer(happy);
    const status = await readCodexQuota(server.spawnServer, 1000);
    expect(server.state.spawned).toEqual([['codex', ['app-server']]]);
    expect(server.sent.map((m) => m['method'])).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    expect(server.sent[0]).toMatchObject({ id: 1, params: { clientInfo: { name: 'agent-control-lab' } } });
    expect(status).toEqual({
      state: 'ok',
      plan: 'pro',
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: '2027-01-15T08:00:00.000Z' },
      secondary: { usedPercent: 40, windowMinutes: 10080 },
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(server.state.killed).toBe(1);
  });

  it('does not send the quota request before initialize is answered', async () => {
    const server = fakeServer(() => undefined);
    await readCodexQuota(server.spawnServer, 20);
    expect(server.sent.map((m) => m['method'])).toEqual(['initialize']);
  });

  it('ignores garbage lines and server-initiated requests', async () => {
    const server = fakeServer((message, emit) => {
      if (message['id'] === 1) {
        emit('not json');
        emit({ id: 99, method: 'something/ask', params: {} });
        emit({ id: 1, result: {} });
      }
      if (message['id'] === 2) emit({ id: 2, result: LIMITS });
    });
    expect(await readCodexQuota(server.spawnServer, 1000)).toMatchObject({ state: 'ok', plan: 'pro' });
  });

  it('reports a rejected request with a fixed message, never the server text', async () => {
    const server = fakeServer((message, emit) => {
      if (message['id'] === 1) emit({ id: 1, result: {} });
      if (message['id'] === 2) {
        emit({ id: 2, error: { code: -32603, message: 'oauth token for me@example.com invalid' } });
      }
    });
    const status = await readCodexQuota(server.spawnServer, 1000);
    expect(status).toEqual({ state: 'error', error: 'quota request was rejected' });
    expect(server.state.killed).toBe(1);
  });

  it('times out and still stops the process', async () => {
    const server = fakeServer(() => undefined);
    expect(await readCodexQuota(server.spawnServer, 20)).toEqual({ state: 'error', error: 'timed out' });
    expect(server.state.killed).toBe(1);
  });

  it('maps early exit and missing binary', async () => {
    const early = fakeServer((message) => {
      if (message['id'] === 1) queueMicrotask(() => { early.exit({ notFound: false }); });
    });
    expect(await readCodexQuota(early.spawnServer, 1000)).toEqual({
      state: 'error',
      error: 'app-server exited before replying',
    });
    const missing = fakeServer((message) => {
      if (message['id'] === 1) queueMicrotask(() => { missing.exit({ notFound: true }); });
    });
    expect(await readCodexQuota(missing.spawnServer, 1000)).toEqual({ state: 'not-installed' });
    expect(early.state.killed + missing.state.killed).toBe(2);
  });
});

describe('parseRateLimits', () => {
  it('prefers the codex bucket and clamps percentages', () => {
    const status = parseRateLimits({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: { codex: { planType: 'plus', primary: { usedPercent: 140 } } },
    });
    expect(status).toEqual({ state: 'ok', plan: 'plus', primary: { usedPercent: 100 } });
  });

  it('drops unknown plans and invalid values, leaving fields undefined', () => {
    const status = parseRateLimits({
      rateLimits: {
        planType: 'me@example.com',
        primary: { usedPercent: 'x', windowDurationMins: -5, resetsAt: 'soon' },
      },
    });
    expect(status).toEqual({ state: 'ok', primary: {} });
  });

  it('returns ok with nothing when the payload is unrecognised', () => {
    expect(parseRateLimits(null)).toEqual({ state: 'ok' });
    expect(parseRateLimits({ rateLimits: 5 })).toEqual({ state: 'ok' });
  });
});
