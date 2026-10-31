import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../bin/agent-control-lab.js', import.meta.url));
const windows = process.platform === 'win32';
const CLAUDE_FLAGS = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--permission-mode <mode>', '--allowedTools <tools...>', '--disallowedTools <tools...>', '--output-format <format>'];
const SUBSCRIPTION = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', email: 'me@example.com' };

// Fake `claude` and `codex` so the whole GUI path runs without contacting any model.
const FAKE_CLAUDE = `
const fs = require('node:fs'); const path = require('node:path');
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(mode.help.join('\\n')); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify(mode.auth)); process.exit(0); }
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (args.includes('-p')) fs.appendFileSync(path.join(__dirname, 'calls.log'), 'claude\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-fake-1': {} }, result: 'PLAN: add the flag. key sk-abcdefghijklmnopqrstuvwx' }));
});
`;
const FAKE_CODEX = `
const fs = require('node:fs'); const path = require('node:path');
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 1.0.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (args[0] === 'exec') fs.appendFileSync(path.join(__dirname, 'calls.log'), 'codex\\n');
  if (args[0] === 'exec' && mode.write && args.includes('workspace-write')) fs.writeFileSync(path.join(process.cwd(), 'new.txt'), 'hello\\n');
  if (mode.codex === 'hang' && args[0] === 'exec') { setInterval(() => undefined, 1000); return; }
  console.log('VERDICT: approve');
});
`;

let root = '';
let bin = '';
let proj = '';
let child: ChildProcess | undefined;
let base = '';
let token = '';

function shim(name: string, script: string): void {
  writeFileSync(join(bin, `fake-${name}.js`), script);
  const file = join(bin, windows ? `${name}.cmd` : name);
  writeFileSync(file, windows ? `@echo off\r\nnode "%~dp0fake-${name}.js" %*\r\n` : `#!/bin/sh\nexec node "${join(bin, `fake-${name}.js`)}" "$@"\n`);
  chmodSync(file, 0o755);
}
const setMode = (over: Record<string, unknown> = {}): void => {
  writeFileSync(join(bin, 'mode.json'), JSON.stringify({ help: CLAUDE_FLAGS, auth: SUBSCRIPTION, codex: 'ok', ...over }));
};
const calls = (): string[] => (existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl gui ')));
  bin = join(root, 'bin');
  proj = join(root, 'proj');
  const home = join(root, 'home');
  for (const d of [bin, proj, home, join(root, 'config')]) mkdirSync(d);
  execFileSync('git', ['init', '-q'], { cwd: proj, stdio: 'ignore' });
  shim('claude', FAKE_CLAUDE);
  shim('codex', FAKE_CODEX);
  setMode();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== 'path' && !/^(ANTHROPIC_|CLAUDE_CODE_USE_|OPENAI_|CODEX_API|NODE_EXTRA_CA|NODE_TLS|SSL_CERT|GIT_)|_PROXY$/i.test(key)) env[key] = value;
  }
  env['PATH'] = [bin, process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter);
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(root, 'config'), HOME: home, USERPROFILE: home, ACL_CACHE_DIR: join(home, 'acl-cache') });
  child = spawn(process.execPath, [cli, 'gui', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child?.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m !== null) resolve(m[0].replace(/\/$/, ""));
    });
    child?.on('exit', () => { reject(new Error('gui exited')); });
  });
  const html = await (await fetch(base)).text();
  token = /name="acl-token" content="([a-f0-9]+)"/.exec(html)?.[1] ?? '';
}, 30_000);

afterAll(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

const api = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-acl-token': token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const req = (over: Record<string, unknown> = {}) => ({ workflow: 'plan-review', task: 'add a --json flag', routing: 'auto', policy: 'balanced', cwd: proj, timeoutSec: 60, steps: {}, ...over });
type Snap = { status: string; steps: { id: string; status: string; provider?: string }[]; lines: string[]; sections?: { id: string; text: string }[]; refusal?: string[] };
async function settle(): Promise<Snap> {
  for (let i = 0; i < 300; i += 1) {
    const snap = (await (await api('/api/run')).json()) as Snap;
    if (snap.status !== 'running' && snap.status !== 'cancelling') return snap;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('run did not settle');
}

describe('GUI plan-review run against fake CLIs (no model is contacted)', () => {
  it('refuses a run without a preview, starts neither CLI, then runs Claude → Codex after the preview', async () => {
    expect((await api('/api/run', { ...req(), confirm: true })).status).toBe(409);
    expect(calls()).toEqual([]);
    const preview = (await (await api('/api/dry-run', req())).json()) as { exitCode: number; view: { verdict: string } };
    expect(preview.view.verdict).toBe('would-run');
    expect(calls()).toEqual([]);
    expect((await api('/api/run', { ...req(), confirm: true })).status).toBe(202);
    const done = await settle();
    expect(done.status).toBe('completed');
    expect(calls()).toEqual(['claude', 'codex']);
    expect(done.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
    expect(done.sections?.map((s) => s.id)).toEqual(['plan', 'review']);
    expect(JSON.stringify(done)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(done.sections?.[0]?.text).toContain('PLAN: add the flag');
  }, 60_000);

  it('cancels a hung Codex step, stops it and reports cancelled', async () => {
    setMode({ codex: 'hang' });
    await api('/api/dry-run', req());
    expect((await api('/api/run', { ...req(), confirm: true })).status).toBe(202);
    for (let i = 0; i < 100; i += 1) {
      const s = (await (await api('/api/run')).json()) as Snap;
      if (s.steps.find((x) => x.id === 'review')?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(((await (await api('/api/run/cancel', {})).json()) as { cancelled: boolean }).cancelled).toBe(true);
    const done = await settle();
    expect(done.status).toBe('cancelled');
    expect(done.steps.find((x) => x.id === 'plan')?.status).toBe('completed');
  }, 60_000);

  it('shows the CLI preflight refusal instead of skipping it', async () => {
    setMode({ auth: { ...SUBSCRIPTION, loggedIn: false } });
    const preview = (await (await api('/api/dry-run', req())).json()) as { view: { verdict: string } };
    expect(preview.view.verdict).toBe('would-refuse');
    expect((await api('/api/run', { ...req(), confirm: true })).status).toBe(409);
  }, 60_000);
});

describe('GUI per-step provider choice against fake CLIs (no model is contacted)', () => {
  type Preview = { exitCode: number; view: { verdict: string; steps: { id: string; provider: string; verdict: string; model?: { value: string } }[] } };
  const preview = async (body: unknown) => (await (await api('/api/dry-run', body)).json()) as Preview;
  const combos = [['claude', 'claude'], ['codex', 'claude'], ['codex', 'codex'], ['claude', 'codex']] as const;

  it.each(combos)('plan on %s, review on %s: previews, then runs exactly those providers in order', async (plan, review) => {
    setMode();
    const body = req({ steps: { providers: { plan, review } } });
    const before = calls().length;
    const p = await preview(body);
    expect(p.view.verdict).toBe('would-run');
    expect(p.view.steps.map((s) => `${s.id}:${s.provider}`)).toEqual([`plan:${plan}`, `review:${review}`]);
    expect(calls().length).toBe(before);
    expect((await api('/api/run', { ...body, confirm: true })).status).toBe(202);
    const done = await settle();
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => s.provider)).toEqual([plan, review]);
    expect(calls().slice(before)).toEqual([plan, review]);
  }, 60_000);

  it('needs a new preview when the provider changes after it', async () => {
    setMode();
    await preview(req());
    const swapped = req({ steps: { providers: { plan: 'codex' } } });
    const before = calls().length;
    expect((await api('/api/run', { ...swapped, confirm: true })).status).toBe(409);
    expect(calls().length).toBe(before);
  });

  it('refuses invalid provider choices and keeps plan-implement-review preview only', async () => {
    setMode();
    for (const providers of [{ plan: 'gemini' }, { implement: 'claude' }, { verify: 'codex' }]) {
      expect((await api('/api/dry-run', req({ steps: { providers } }))).status).toBe(400);
    }
    const pir = req({ workflow: 'plan-implement-review', cwd: undefined, workspace: proj, steps: { providers: { plan: 'codex', review: 'codex' } } });
    const p = (await (await api('/api/dry-run', pir)).json()) as Preview;
    expect(p.view.steps.map((s) => `${s.id}:${s.provider}`).slice(0, 2)).toEqual(['plan:codex', 'implement:codex']);
    const before = calls().length;
    expect((await api('/api/run', { ...pir, confirm: true })).status).toBe(400);
    expect(calls().length).toBe(before);
  });

  it('refuses a model of the other provider at preflight, and shows it in the preview', async () => {
    setMode();
    const p = await preview(req({ steps: { providers: { review: 'claude' }, models: { review: 'gpt-nope' } } }));
    expect(p.view.verdict).toBe('would-refuse');
    const before = calls().length;
    expect((await api('/api/run', { ...req({ steps: { providers: { review: 'claude' }, models: { review: 'gpt-nope' } } }), confirm: true })).status).toBe(409);
    expect(calls().length).toBe(before);
  });
});

describe('GUI real plan-implement-review run against fake CLIs and real Git (no model is contacted)', () => {
  let main = '';
  let wt = '';
  let marks = '';
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const body = (over: Record<string, unknown> = {}) => ({ workflow: 'plan-implement-review', task: 'add a --json flag', routing: 'auto', policy: 'balanced', workspace: wt, timeoutSec: 60, steps: {}, ...over });
  type Run = Snap & { workspace?: { readable: boolean; committed: boolean; branch?: string; headBefore?: string; headAfter?: string; files: { path: string; kind: string }[] } };

  beforeAll(() => {
    main = join(root, 'pir main');
    wt = join(root, 'pir wt');
    marks = join(root, 'marks.log');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    writeFileSync(join(main, 'check.js'), `require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'verified\\n');\n`);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  });

  it('refuses without preview and write confirmation, then writes only in the worktree, shows live steps and the real Git state', async () => {
    setMode({ write: true });
    const before = calls().length;
    expect((await api('/api/run', { ...body(), confirm: true, confirmWrite: true })).status).toBe(409); // no preview
    const preview = (await (await api('/api/dry-run', body())).json()) as { view: { verdict: string; steps: { id: string; provider: string }[] } };
    expect(preview.view.verdict).toBe('would-run');
    expect(calls().length).toBe(before);
    expect((await api('/api/run', { ...body(), confirm: true })).status).toBe(400); // no write confirmation
    expect(calls().length).toBe(before);
    const head = git(wt, 'rev-parse', 'HEAD');
    expect((await api('/api/run', { ...body(), confirm: true, confirmWrite: true })).status).toBe(202);
    const done = (await settle()) as Run;
    expect(done.status).toBe('completed');
    expect(calls().slice(before)).toEqual(['claude', 'codex', 'claude']);
    expect(done.steps.map((s) => `${s.id}:${s.provider ?? ''}:${s.status}`)).toEqual(['plan:claude:completed', 'implement:codex:completed', 'inspect:local:completed', 'review:claude:completed']);
    expect(done.workspace).toMatchObject({ readable: true, committed: false, branch: 'feature', headBefore: head, headAfter: head });
    expect(done.workspace?.files).toEqual([{ path: 'new.txt', kind: 'new', bytes: 6 }]);
    expect(JSON.stringify(done)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
    expect(existsSync(join(main, 'new.txt'))).toBe(false);
    expect(git(main, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    rmSync(join(wt, 'new.txt'));
  }, 90_000);

  it('runs the test command only with its own confirmation', async () => {
    setMode({ write: true });
    const b = body({ verify: 'node check.js' });
    await api('/api/dry-run', b);
    const before = calls().length;
    expect((await api('/api/run', { ...b, confirm: true, confirmWrite: true })).status).toBe(400);
    expect(calls().length).toBe(before);
    expect(existsSync(marks)).toBe(false);
    await api('/api/dry-run', b);
    expect((await api('/api/run', { ...b, confirm: true, confirmWrite: true, confirmVerify: true })).status).toBe(202);
    const done = (await settle()) as Run;
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => s.id)).toEqual(['plan', 'implement', 'inspect', 'verify', 'review']);
    expect(readFileSync(marks, 'utf8')).toBe('verified\n');
    rmSync(join(wt, 'new.txt'));
  }, 90_000);

  it('refuses when the worktree changed after the preview, and the CLI itself refuses a dirty one', async () => {
    setMode({ write: true });
    await api('/api/dry-run', body());
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    const before = calls().length;
    expect((await api('/api/run', { ...body(), confirm: true, confirmWrite: true })).status).toBe(409);
    expect(calls().length).toBe(before);
    const again = (await (await api('/api/dry-run', body())).json()) as { view: { verdict: string } };
    expect(again.view.verdict).toBe('would-refuse'); // the CLI itself refuses a dirty worktree
    rmSync(join(wt, 'dirty.txt'));
  }, 60_000);

  it('cancels during the implementation, stops Codex and still reports what was written', async () => {
    setMode({ write: true, codex: 'hang' });
    await api('/api/dry-run', body());
    expect((await api('/api/run', { ...body(), confirm: true, confirmWrite: true })).status).toBe(202);
    for (let i = 0; i < 100; i += 1) {
      const s = (await (await api('/api/run')).json()) as Snap;
      if (s.steps.find((x) => x.id === 'implement')?.status === 'running' && existsSync(join(wt, 'new.txt'))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(((await (await api('/api/run/cancel', {})).json()) as { cancelled: boolean }).cancelled).toBe(true);
    const done = (await settle()) as Run;
    expect(done.status).toBe('cancelled');
    expect(done.workspace).toMatchObject({ readable: true, committed: false });
    expect(done.workspace?.files.map((f) => f.path)).toEqual(['new.txt']);
    expect(existsSync(join(wt, 'new.txt'))).toBe(true); // nothing is rolled back
    expect(done.steps.find((x) => x.id === 'inspect')?.status).toBe('completed'); // always runs, even after a cancel
    rmSync(join(wt, 'new.txt'));
  }, 90_000);
});
