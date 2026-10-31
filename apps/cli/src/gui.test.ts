import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeClaudeCache } from '@agent-control-lab/core';
import { buildDryRunArgv, chosenProviders, createGuiServer, fileClaudeIntegration, listenGui } from './gui.ts';
import { parseGuiArgs } from './gui-command.ts';
import type { WorkspaceProbe, WorkspaceReport, WorkspaceState } from './gui-workspace.ts';

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
  it('passes provider choices and rejects invalid ones, and allows Claude for implement', () => {
    const ok = buildDryRunArgv({ ...good, steps: { providers: { plan: 'codex', review: 'claude' } } });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.argv).toEqual(expect.arrayContaining(['--step-provider', 'plan=codex', '--step-provider', 'review=claude']));
    expect(chosenProviders(ok.argv)).toEqual(['codex', 'claude']);
    expect(chosenProviders(['orchestrate'])).toEqual(['claude', 'codex']);
    const wf = { ...good, workflow: 'plan-implement-review', workspace: '/w' };
    for (const bad of [{ plan: 'gemini' }, { plan: '--confirm' }, { verify: 'codex' }, { implement: 5 }]) {
      expect('error' in buildDryRunArgv({ ...wf, steps: { providers: bad } })).toBe(true);
    }
    expect('error' in buildDryRunArgv({ ...wf, steps: { providers: { implement: 'codex', review: 'codex' } } })).toBe(false);
    const claudeImpl = buildDryRunArgv({ ...wf, steps: { providers: { implement: 'claude' }, profiles: { plan: 'text-only', review: 'read-only' } } });
    if ('error' in claudeImpl) throw new Error(claudeImpl.error);
    expect(claudeImpl.argv).toEqual(expect.arrayContaining(['--step-provider', 'implement=claude', '--step-profile', 'plan=text-only']));
    expect(chosenProviders(claudeImpl.argv, 'plan-implement-review')).toEqual(['claude', 'claude', 'claude']);
    for (const bad of [{ plan: 'full-access' }, { plan: 5 }, { gemini: 'read-only' }]) expect('error' in buildDryRunArgv({ ...wf, steps: { profiles: bad } })).toBe(true);
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
    expect((await fetch(`${base}/api/dry-run`)).status).toBe(403);
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

describe('real plan-review run gate', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...good, routing: 'auto', cwd: '/tmp/proj', timeoutSec: 120, ...over });
  const fake = (calls: string[][], opts: { quota?: string; hang?: boolean; code?: number } = {}) =>
    createGuiServer({
      token: TOKEN,
      watchdogMs: 5000,
      run: (argv, io, signal) => {
        calls.push([...argv]);
        if (argv[0] === 'quota') { io.out(opts.quota ?? 'Codex plan: plus\n  5h window (primary): 3% used\n'); return Promise.resolve(0); }
        if (argv.includes('--dry-run')) { io.out('orchestrate plan (dry run, no agent started)\n  verdict: would run\n'); return Promise.resolve(0); }
        io.error('step 1/2 plan [claude] running\n');
        if (opts.hang === true) return new Promise((resolve) => { signal?.addEventListener('abort', () => { resolve(130); }); });
        io.error('step 1/2 plan [claude] completed (1.0s)\nstep 2/2 review [codex] completed (1.0s)\n');
        io.out('== step 1/2 plan [claude] completed (1.0s) ==\nPLAN sk-abcdefghijklmnopqrstuv\n\nsummary: plan-review completed\n');
        return Promise.resolve(opts.code ?? 0);
      },
    });
  const boot = async (server: ReturnType<typeof fake>) => {
    open.push(server);
    return `http://127.0.0.1:${String(await listenGui(server, 0))}`;
  };
  const get = (base: string, path: string) => fetch(`${base}${path}`, { headers: { 'x-acl-token': TOKEN } });
  const settle = async (base: string) => {
    for (let i = 0; i < 50; i += 1) {
      const snap = (await (await get(base, '/api/run')).json()) as { status: string };
      if (snap.status !== 'running' && snap.status !== 'cancelling') return snap as { status: string; steps: { status: string }[]; lines: string[]; sections?: { text: string }[] };
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('run did not settle');
  };

  it('needs explicit confirmation, a project directory, plan-review only and a matching preview', async () => {
    const calls: string[][] = [];
    const base = await boot(fake(calls));
    const run = (b: unknown) => fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    expect((await run(body())).status).toBe(400); // no confirm
    expect((await run(body({ confirm: true, workflow: 'plan-implement-review', workspace: '/w' }))).status).toBe(400);
    expect((await run(body({ confirm: true, cwd: '' }))).status).toBe(400);
    expect((await run(body({ confirm: true }))).status).toBe(409); // no preview yet
    expect(calls.filter((c) => !c.includes('--dry-run'))).toEqual([]);
  });

  it('runs once after a matching preview, masks output, and a changed task needs a new preview', async () => {
    const calls: string[][] = [];
    const base = await boot(fake(calls));
    const api = (path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    expect((await api('/api/dry-run', body())).status).toBe(200);
    expect((await api('/api/run', body({ confirm: true, task: 'changed' }))).status).toBe(409);
    expect((await api('/api/run', body({ confirm: true }))).status).toBe(202);
    const done = await settle(base);
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
    expect(JSON.stringify(done)).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(done.sections?.[0]?.text).toContain('[maskelendi]');
    const real = calls.find((c) => c.includes('--confirm'));
    expect(real).toEqual(expect.arrayContaining(['orchestrate', '--workflow', 'plan-review', '--cwd', '/tmp/proj', '--timeout', '120', '--no-record']));
    expect(real).not.toContain('--dry-run');
    expect(real).not.toContain('--accept-unverified');
    expect((await api('/api/run', body({ confirm: true }))).status).toBe(409); // preview was used up
  });

  it('applies --accept-unverified to the real run only with its own explicit confirmation, without consuming the preview', async () => {
    const calls: string[][] = [];
    const base = await boot(fake(calls));
    const api = (path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    const b = body({ acceptUnverified: true });
    expect((await api('/api/dry-run', b)).status).toBe(200);
    expect(calls.find((c) => c.includes('--dry-run'))).toContain('--accept-unverified');
    const refused = await api('/api/run', { ...b, confirm: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('--accept-unverified');
    expect((await api('/api/run', { ...b, confirm: true, confirmAcceptUnverified: false })).status).toBe(400);
    expect(calls.some((c) => c.includes('--confirm'))).toBe(false);
    expect((await api('/api/run', { ...b, confirm: true, confirmAcceptUnverified: true })).status).toBe(202); // the same preview still counts
    await settle(base);
    expect(calls.find((c) => c.includes('--confirm'))).toContain('--accept-unverified');
  });

  it('a run without --accept-unverified never carries it, whatever else is sent', async () => {
    const calls: string[][] = [];
    const base = await boot(fake(calls));
    const api = (path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    await api('/api/dry-run', body());
    expect((await api('/api/run', body({ confirm: true, confirmAcceptUnverified: true }))).status).toBe(202);
    await settle(base);
    expect(calls.find((c) => c.includes('--confirm'))).not.toContain('--accept-unverified');
  });

  it('allows one run at a time, blocks previews meanwhile, and cancels', async () => {
    const calls: string[][] = [];
    const base = await boot(fake(calls, { hang: true }));
    const api = (path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    await api('/api/dry-run', body());
    expect((await api('/api/run', body({ confirm: true }))).status).toBe(202);
    await api('/api/dry-run', body({ task: 'other' })).then((r) => { expect(r.status).toBe(409); });
    expect((await api('/api/run', body({ confirm: true }))).status).toBe(409);
    expect((await get(base, '/api/status')).status).toBe(409);
    expect(((await (await api('/api/run/cancel', {})).json()) as { cancelled: boolean }).cancelled).toBe(true);
    expect((await settle(base)).status).toBe('cancelled');
  });

  it('refuses to start when quota is nearly used up, and shows a failed run as failed', async () => {
    const full = await boot(fake([], { quota: 'Codex plan: plus\n  5h window (primary): 97% used\n' }));
    const post2 = (base: string, path: string, b: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    await post2(full, '/api/dry-run', body());
    const res = await post2(full, '/api/run', body({ confirm: true }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('quota');
    expect((await get(full, '/api/run')).status).toBe(200);
    expect(((await (await get(full, '/api/run')).json()) as { status: string }).status).toBe('idle');
    const bad = await boot(fake([], { code: 1 }));
    await post2(bad, '/api/dry-run', body());
    await post2(bad, '/api/run', body({ confirm: true }));
    expect((await settle(bad)).status).toBe('failed');
  });

  it('checks quota only for the providers the run uses', async () => {
    const full = await boot(fake([], { quota: 'Codex plan: plus\n  5h window (primary): 97% used\n' }));
    const post2 = (path: string, b: unknown) => fetch(`${full}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, body: JSON.stringify(b) });
    const claudeOnly = body({ steps: { providers: { plan: 'claude', review: 'claude' } } });
    await post2('/api/dry-run', claudeOnly);
    expect((await post2('/api/run', { ...claudeOnly, confirm: true })).status).toBe(202);
    await settle(full);
    const swapped = body({ steps: { providers: { plan: 'codex' } } });
    await post2('/api/dry-run', swapped);
    expect((await post2('/api/run', { ...swapped, confirm: true })).status).toBe(409);
    expect((await post2('/api/run', { ...swapped, confirm: true })).status).toBe(409);
  });

  it('lists only directories, needs the token, and rejects relative paths', async () => {
    const base = await boot(fake([]));
    expect((await fetch(`${base}/api/dirs?path=/tmp`)).status).toBe(403);
    expect((await get(base, '/api/dirs?path=relative')).status).toBe(400);
    const ok = (await (await get(base, `/api/dirs?path=${encodeURIComponent(process.cwd())}`)).json()) as { path: string; dirs: string[] };
    expect(ok.path).toBe(process.cwd());
    expect(ok.dirs.every((d) => !d.startsWith('.'))).toBe(true);
  });

  it('discovers workspaces over the token-protected endpoint and only suggests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acl gui ws '));
    try {
      await mkdir(join(root, 'billing', '.git'), { recursive: true });
      await mkdir(join(root, 'a', 'shared'), { recursive: true });
      await mkdir(join(root, 'b', 'shared'), { recursive: true });
      await writeFile(join(root, 'a', 'shared', 'package.json'), '{}');
      await writeFile(join(root, 'b', 'shared', 'package.json'), '{}');
      const base = await boot(fake([]));
      const send = (body: unknown, token = TOKEN) => fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': token }, body: JSON.stringify(body) });
      expect((await send({ root }, 'wrong')).status).toBe(403);
      expect((await send({ root: 'relative' })).status).toBe(400);
      expect((await send({ root: join(root, 'missing') })).status).toBe(400);
      const plain = (await (await send({ root })).json()) as { candidates: { relative: string }[]; suggestion?: unknown };
      expect(plain.candidates.map((c) => c.relative)).toContain('billing');
      expect(plain.suggestion).toBeUndefined();
      const one = (await (await send({ root, task: 'fix billing' })).json()) as { suggestion: { state: string } };
      expect(one.suggestion.state).toBe('suggested');
      const two = (await (await send({ root, task: 'update shared code' })).json()) as { suggestion: { state: string } };
      expect(two.suggestion.state).toBe('ambiguous');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Claude quota integration endpoints', () => {
  let root = '';
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const setup = async (settings?: unknown) => {
    root = await mkdtemp(join(tmpdir(), 'acl gui claude '));
    await mkdir(join(root, 'claude'));
    const settingsPath = join(root, 'claude', 'settings.json');
    if (settings !== undefined) await writeFile(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings));
    const paths = { settingsPath, cacheDir: join(root, 'cache'), nodePath: '/usr/bin/node', binPath: '/opt/acl/bin/a.js' };
    const server = createGuiServer({ token: TOKEN, claude: fileClaudeIntegration(paths), run: () => Promise.resolve(0) });
    open.push(server);
    const base = `http://127.0.0.1:${String(await listenGui(server, 0))}`;
    const call = (path: string, body?: unknown, token = TOKEN) =>
      fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-acl-token': token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { paths, call };
  };

  it('needs the token and reports why there is no data', async () => {
    const { call } = await setup({ theme: 'dark' });
    expect((await call('/api/claude', undefined, 'nope')).status).toBe(403);
    const d = (await (await call('/api/claude')).json()) as { reason: string; plan: { action: string; id: string; display: string } };
    expect(d.reason).toBe('not-installed');
    expect(d.plan.action).toBe('add');
  });
  it('installs only with confirmation and the reviewed plan id, shows the real command masked, and undoes it', async () => {
    const original = { type: 'command', command: './mine.sh --token sk-abcdefghijklmnopqrstu' };
    const { paths, call } = await setup({ keep: 1, statusLine: original });
    const d = (await (await call('/api/claude')).json()) as { plan: { action: string; id: string; display: string } };
    expect(d.plan.action).toBe('chain');
    expect(d.plan.display).not.toContain('sk-abcdefghijklmnopqrstu');
    expect(d.plan.display).toContain('mine.sh');
    expect((await call('/api/claude/install', { planId: d.plan.id })).status).toBe(400);
    expect((await call('/api/claude/install', { confirm: true, planId: 'stale' })).status).toBe(409);
    expect((JSON.parse(await readFile(paths.settingsPath, 'utf8')) as { statusLine: unknown }).statusLine).toEqual(original);
    const done = await call('/api/claude/install', { confirm: true, planId: d.plan.id });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { diagnosis: { installed: boolean; restorable: boolean } }).diagnosis).toMatchObject({ installed: true, restorable: true });
    expect((JSON.parse(await readFile(paths.settingsPath, 'utf8')) as { keep: number }).keep).toBe(1);
    expect((await call('/api/claude/uninstall', {})).status).toBe(400);
    expect((await call('/api/claude/uninstall', { confirm: true })).status).toBe(200);
    expect(JSON.parse(await readFile(paths.settingsPath, 'utf8'))).toEqual({ keep: 1, statusLine: original });
  });
  it('reports a refusal reason and leaves an unparsable settings file alone', async () => {
    const { paths, call } = await setup('{ // c\n}');
    const bad = await call('/api/claude/install', { confirm: true, planId: 'x' });
    expect(bad.status).toBe(409);
    expect(await readFile(paths.settingsPath, 'utf8')).toBe('{ // c\n}');
    expect((await call('/api/claude/uninstall', { confirm: true })).status).toBe(409);
  });
  it('does not start a real run when fresh Claude quota is nearly used up', async () => {
    const calls: string[][] = [];
    root = await mkdtemp(join(tmpdir(), 'acl gui claude '));
    const paths = { settingsPath: join(root, 's.json'), cacheDir: join(root, 'cache'), nodePath: '/n', binPath: '/a' };
    await writeFile(paths.settingsPath, JSON.stringify({ statusLine: { type: 'command', command: '"/n" "/a" statusline-collect' } }));
    await writeClaudeCache(paths.cacheDir, { state: 'ok', fiveHour: { windowMinutes: 300, usedPercent: 97, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } }, new Date());
    const server = createGuiServer({
      token: TOKEN,
      claude: fileClaudeIntegration(paths),
      run: (argv, io) => {
        calls.push([...argv]);
        io.out(argv[0] === 'quota' ? 'Codex plan: plus\n  5h window (primary): 3% used\n' : 'orchestrate plan (dry run, no agent started)\n  verdict: would run\n');
        return Promise.resolve(0);
      },
    });
    open.push(server);
    const base = `http://127.0.0.1:${String(await listenGui(server, 0))}`;
    const send = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-acl-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const b = { workflow: 'plan-review', task: 'do it', routing: 'auto', policy: 'balanced', steps: {}, cwd: '/tmp/proj', timeoutSec: 120 };
    await send('/api/dry-run', b);
    const res = await send('/api/run', { ...b, confirm: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('claude 5h window');
    expect(calls.some((c) => c.includes('--confirm'))).toBe(false);
  });
});

describe('real plan-implement-review run gate', () => {
  const state = (fingerprint: string): WorkspaceState => ({ fingerprint, root: '/w', head: 'a'.repeat(40), branch: 'feature', refs: 'r' });
  const report: WorkspaceReport = { readable: true, root: '/w', branch: 'feature', headBefore: 'a'.repeat(40), headAfter: 'a'.repeat(40), committed: false, files: [{ path: 'a.txt', kind: 'changed', added: 1, deleted: 1 }], truncated: false, added: 1, deleted: 1 };
  const body = (over: Record<string, unknown> = {}) => ({ workflow: 'plan-implement-review', task: 'do it', routing: 'auto', policy: 'balanced', steps: {}, workspace: '/w', timeoutSec: 120, ...over });
  function make(opts: { fingerprint?: () => string | undefined; quota?: string; hang?: boolean } = {}) {
    const calls: string[][] = [];
    const reads: string[] = [];
    const probe: WorkspaceProbe = {
      read: (path) => { reads.push(path); const f = opts.fingerprint?.() ?? 'fp1'; return Promise.resolve(f === 'unreadable' ? undefined : state(f)); },
      report: () => Promise.resolve(report),
    };
    const server = createGuiServer({
      token: TOKEN,
      watchdogMs: 5000,
      workspace: probe,
      run: (argv, io, signal) => {
        calls.push([...argv]);
        if (argv[0] === 'quota') { io.out(opts.quota ?? 'Codex plan: plus\n  5h window (primary): 3% used\n'); return Promise.resolve(0); }
        if (argv.includes('--dry-run')) { io.out('orchestrate plan (dry run, no agent started)\n  verdict: would run\n'); return Promise.resolve(0); }
        io.error('step 1/4 plan [claude] running\n');
        if (opts.hang === true) return new Promise((resolve) => { signal?.addEventListener('abort', () => { resolve(130); }); });
        io.error('step 1/4 plan [claude] completed (1.0s)\nstep 3/4 inspect [local] completed (0.1s)\n');
        return Promise.resolve(0);
      },
    });
    open.push(server);
    return { calls, reads, server };
  }
  async function boot(m: ReturnType<typeof make>) {
    const base = `http://127.0.0.1:${String(await listenGui(m.server, 0))}`;
    const api = (path: string, b?: unknown) => fetch(`${base}${path}`, { method: b === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-acl-token': TOKEN }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
    const settle = async () => {
      for (let i = 0; i < 100; i += 1) {
        const snap = (await (await api('/api/run')).json()) as { status: string; steps: { id: string; provider: string }[]; workspace?: WorkspaceReport };
        if (snap.status !== 'running' && snap.status !== 'cancelling') return snap;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('run did not settle');
    };
    return { api, settle };
  }
  const OK = { confirm: true, confirmWrite: true };

  it('needs the preview, its own write confirmation and a readable worktree', async () => {
    const m = make();
    const { api } = await boot(m);
    expect((await api('/api/run', body({ confirm: true }))).status).toBe(400); // no write confirmation
    expect((await api('/api/run', body({ ...OK, workspace: 'relative' }))).status).toBe(400);
    expect((await api('/api/run', body(OK))).status).toBe(409); // no preview
    expect(m.calls.some((c) => c.includes('--confirm-write'))).toBe(false);
    const bad = make({ fingerprint: () => 'unreadable' });
    const b = await boot(bad);
    const shown = (await (await b.api('/api/dry-run', body())).json()) as { runnable: boolean };
    expect(shown.runnable).toBe(false); // the page keeps its run button disabled
    expect((await b.api('/api/run', body(OK))).status).toBe(409); // unreadable workspace is never previewed as runnable
    expect(bad.calls.some((c) => c.includes('--confirm-write'))).toBe(false);
  });

  it('refuses when the worktree changed after the preview, and uses the preview only once', async () => {
    let fp = 'fp1';
    const m = make({ fingerprint: () => fp });
    const { api, settle } = await boot(m);
    expect(((await (await api('/api/dry-run', body())).json()) as { runnable: boolean }).runnable).toBe(true);
    fp = 'fp2';
    const res = await api('/api/run', body(OK));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('changed since the preview');
    expect((await api('/api/run', body(OK))).status).toBe(409); // preview consumed
    fp = 'fp3';
    await api('/api/dry-run', body());
    expect((await api('/api/run', body(OK))).status).toBe(202);
    expect((await settle()).status).toBe('completed');
  });

  it('builds the write argv from the previewed one, adds the test command only with its own confirmation, and reports the real workspace', async () => {
    const m = make();
    const { api, settle } = await boot(m);
    const withVerify = body({ verify: 'pnpm test' });
    await api('/api/dry-run', withVerify);
    expect((await api('/api/run', { ...withVerify, ...OK })).status).toBe(400); // test command needs its own confirmation
    await api('/api/dry-run', withVerify);
    expect((await api('/api/run', { ...withVerify, ...OK, confirmVerify: true })).status).toBe(202);
    const done = await settle();
    const real = m.calls.find((c) => c.includes('--confirm-write'));
    expect(real).toBeDefined();
    expect(real).not.toContain('--dry-run');
    expect(real).toEqual(expect.arrayContaining(['--confirm-verify', '--verify-command', 'pnpm test', '--workspace', '/w']));
    expect(done.steps.map((s) => `${s.id}:${s.provider}`)).toEqual(['plan:claude', 'implement:codex', 'inspect:local', 'verify:local', 'review:claude']);
    expect(done.workspace).toEqual(report);
    await api('/api/dry-run', body());
    expect((await api('/api/run', { ...body(), ...OK })).status).toBe(202);
    await settle();
    const plain = m.calls.filter((c) => c.includes('--confirm-write')).at(-1);
    expect(plain).not.toContain('--confirm-verify');
    expect(plain).not.toContain('--verify-command');
  });

  it('applies the quota guard to the Codex implementation even when plan and review use Claude', async () => {
    const m = make({ quota: 'Codex plan: plus\n  5h window (primary): 97% used\n' });
    const { api } = await boot(m);
    const b = body({ steps: { providers: { plan: 'claude', review: 'claude' } } });
    await api('/api/dry-run', b);
    const res = await api('/api/run', { ...b, ...OK });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('quota');
    expect(m.calls.some((c) => c.includes('--confirm-write'))).toBe(false);
  });

  it('cancels a write run and still reports the workspace read afterwards', async () => {
    const m = make({ hang: true });
    const { api, settle } = await boot(m);
    await api('/api/dry-run', body());
    expect((await api('/api/run', { ...body(), ...OK })).status).toBe(202);
    expect(((await (await api('/api/run/cancel', {})).json()) as { cancelled: boolean }).cancelled).toBe(true);
    const done = await settle();
    expect(done.status).toBe('cancelled');
    expect(done.workspace?.readable).toBe(true);
  });
});
