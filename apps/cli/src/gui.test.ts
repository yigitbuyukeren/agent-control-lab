import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import { buildDryRunArgv, createGuiServer, listenGui } from './gui.ts';
import { parseGuiArgs } from './gui-command.ts';

const TOKEN = 'test-token';
const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => { r(); }); })));
});

async function start(calls: string[][] = [], exit = 0) {
  const server = createGuiServer({
    token: TOKEN,
    run: (argv, io) => {
      calls.push([...argv]);
      io.out('orchestrate plan (dry run, no agent started)\n  step 1/2 plan [claude]: ok\n  verdict: would run\n');
      return Promise.resolve(exit);
    },
  });
  open.push(server);
  const port = await listenGui(server, 0);
  return { port, base: `http://127.0.0.1:${String(port)}` };
}

const good = { workflow: 'plan-review', task: 'do it', routing: 'guided', policy: 'quality', steps: {} };
const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/dry-run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** fetch() silently drops Host and Origin, so the header checks use a raw request. */
const raw = (port: number, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/dry-run', method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(JSON.stringify(good));
  });

describe('buildDryRunArgv', () => {
  it('always dry-runs without recording and never confirms', () => {
    const built = buildDryRunArgv({ ...good, task: '--confirm --task x' });
    if ('error' in built) throw new Error(built.error);
    expect(built.argv).toContain('--dry-run');
    expect(built.argv).toContain('--no-record');
    expect(built.argv.filter((a) => /^--confirm(-write|-verify)?$/.test(a))).toEqual([]);
    expect(built.argv[4]).toBe('--confirm --task x');
  });
  it('rejects unknown values and bad step settings', () => {
    for (const bad of [{ ...good, workflow: 'x' }, { ...good, routing: 'x' }, { ...good, policy: 'x' }, { ...good, task: ' ' }, { ...good, steps: { models: { implement: 'm' } } }, { ...good, steps: { models: { plan: '--confirm' } } }, 5]) {
      expect('error' in buildDryRunArgv(bad)).toBe(true);
    }
  });
  it('passes step settings and the write workflow workspace only as dry-run values', () => {
    const built = buildDryRunArgv({ workflow: 'plan-implement-review', task: 't', routing: 'auto', policy: 'balanced', steps: { models: { implement: 'gpt-x' }, efforts: { review: 'high' } }, workspace: '/w', verify: 'pnpm test' });
    if ('error' in built) throw new Error(built.error);
    expect(built.argv).toEqual(expect.arrayContaining(['--step-model', 'implement=gpt-x', '--step-effort', 'review=high', '--workspace', '/w', '--verify-command', 'pnpm test', '--dry-run']));
    expect(built.argv).not.toContain('--confirm-write');
    expect(built.argv).not.toContain('--confirm-verify');
    expect('error' in buildDryRunArgv({ workflow: 'plan-implement-review', task: 't', routing: 'auto', policy: 'balanced' })).toBe(true);
  });
});

describe('gui server', () => {
  it('serves the page with a strict CSP and no stored state', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain(TOKEN);
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|@import|<link|\ssrc=|url\(\s*['"]?https?:/);
    expect(html).toContain('[hidden]{display:none!important}');
    expect(html).toContain('lang="tr"');
    for (const id of ['auto', 'adaptive', 'measured', 'research', 'guided', 'economy', 'balanced', 'quality']) expect(html).toContain(`id:'${id}'`);
  });
  it('runs the CLI in dry-run mode and returns its output', async () => {
    const calls: string[][] = [];
    const { base } = await start(calls);
    const res = await post(base, good);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; output: string };
    expect(body.exitCode).toBe(0);
    expect(body.output).toContain('verdict: would run');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
  });
  it('refuses wrong host, foreign origin, missing token, wrong type, bad JSON and big bodies without running anything', async () => {
    const calls: string[][] = [];
    const { base, port } = await start(calls);
    expect(await raw(port, { host: `evil.example:${String(port)}` })).toBe(403);
    expect(await raw(port, { origin: 'http://evil.example' })).toBe(403);
    expect((await post(base, good, { 'x-acl-token': 'nope' })).status).toBe(403);
    expect((await post(base, good, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(base, '{nope')).status).toBe(400);
    expect((await post(base, 'x'.repeat(70_000))).status).toBe(413);
    expect((await post(base, { ...good, workflow: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/dry-run`)).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it('serves parsed status only with the token and runs just read-only commands', async () => {
    const calls: string[][] = [];
    const server = createGuiServer({
      token: TOKEN,
      run: (argv, io) => {
        calls.push([...argv]);
        io.out(argv[0] === 'providers' ? 'Claude Code  installed 2.1.0\nCodex        installed 0.1.0\n' : argv[0] === 'quota' ? 'Codex plan: plus\n  5h window (primary): 3% used, resets 2026-10-31T03:55:21.000Z\n' : argv[0] === 'auth-status' ? 'Claude Code  logged in (subscription, pro)\n' : 'Codex (discovered via app-server model/list)\n  gpt-x (GPT X): efforts low, high, default low; ultracode mode unsupported\n');
        return Promise.resolve(0);
      },
    });
    open.push(server);
    const base = `http://127.0.0.1:${String(await listenGui(server, 0))}`;
    expect((await fetch(`${base}/api/status`)).status).toBe(403);
    expect(calls).toEqual([]);
    const res = await fetch(`${base}/api/status`, { headers: { 'x-acl-token': TOKEN } });
    const body = (await res.json()) as { providers: { id: string; login?: string }[]; quota: { windows: { usedPercent: number }[] }[]; models: { models: { id: string }[] }[] };
    expect(calls.map((c) => c[0])).toEqual(['providers', 'auth-status', 'quota', 'models']);
    expect(body.providers.map((p) => p.id)).toEqual(['claude', 'codex']);
    expect(body.providers[0]?.login).toContain('logged in');
    expect(body.quota[0]?.windows[0]?.usedPercent).toBe(3);
    expect(body.models[0]?.models[0]?.id).toBe('gpt-x');
  });
  it('only adds --accept-unverified when asked', () => {
    const on = buildDryRunArgv({ ...good, acceptUnverified: true });
    const off = buildDryRunArgv(good);
    if ('error' in on || 'error' in off) throw new Error('unexpected');
    expect(on.argv).toContain('--accept-unverified');
    expect(off.argv).not.toContain('--accept-unverified');
  });
  it('listens on loopback only', async () => {
    const { port } = await start();
    const server = open[0];
    expect((server?.address() as { address: string }).address).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});

describe('parseGuiArgs', () => {
  it('defaults the port and rejects anything else', () => {
    expect(parseGuiArgs([])).toBe(4173);
    expect(parseGuiArgs(['--port', '5000'])).toBe(5000);
    expect(typeof parseGuiArgs(['--port', 'x'])).toBe('string');
    expect(typeof parseGuiArgs(['--open'])).toBe('string');
  });
});
