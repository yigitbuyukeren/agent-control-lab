import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isModelRouting, isPolicyName, isWorkflowName, type WorkflowName } from '@agent-control-lab/core';
import { guiPage } from './gui-page.ts';
import { mergeLogin, parseDryRun, parseModels, parseProviderLines, parseQuota } from './gui-model.ts';
import { RunManager, type GuiRun } from './gui-run.ts';
import { maskSecrets } from './gui-secrets.ts';

export const GUI_DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASK_CHARS = 20_000;
const STEP_NAMES: Readonly<Record<WorkflowName, readonly string[]>> = {
  'plan-review': ['plan', 'review'],
  'plan-implement-review': ['plan', 'implement', 'review'],
};
const STEP_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export interface GuiOptions {
  readonly run: GuiRun;
  /** Per-start secret that every API call must present; injectable for tests. */
  readonly token?: string;
  /** Clock for run timestamps; injectable for tests. */
  readonly now?: () => number;
  /** Hard ceiling for a whole run in ms; defaults to the per-step timeout times the steps plus a minute. */
  readonly watchdogMs?: number;
}

export type { GuiRun } from './gui-run.ts';

type Built = { readonly argv: string[] } | { readonly error: string };

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Turns a validated request into a dry-run argument vector. `--dry-run` is always present; no confirm flag can ever be produced. */
export function buildDryRunArgv(input: unknown): Built {
  const body = obj(input);
  if (body === undefined) return { error: 'request must be a JSON object' };
  const { workflow, task, routing, policy } = body;
  if (typeof workflow !== 'string' || !isWorkflowName(workflow)) return { error: 'unknown workflow' };
  if (typeof task !== 'string' || task.trim() === '' || task.length > MAX_TASK_CHARS) return { error: `task must be 1..${String(MAX_TASK_CHARS)} characters` };
  if (typeof routing !== 'string' || !isModelRouting(routing)) return { error: 'unknown model routing' };
  if (typeof policy !== 'string' || !isPolicyName(policy)) return { error: 'unknown policy' };
  const accept = body['acceptUnverified'] === true ? ['--accept-unverified'] : [];
  const argv = ['orchestrate', '--workflow', workflow, '--task', task, '--dry-run', '--no-record', '--policy', policy, '--model-routing', routing, ...accept];
  const cwd = body['cwd'];
  if (workflow === 'plan-review' && cwd !== undefined && cwd !== '') {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 1024 || cwd.includes('\0')) return { error: 'project directory must be an absolute path' };
    argv.push('--cwd', cwd);
  }
  const timeoutSec = body['timeoutSec'];
  if (timeoutSec !== undefined) {
    if (typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 900) return { error: 'timeout must be 30..900 seconds per step' };
    argv.push('--timeout', String(timeoutSec));
  }
  const steps = obj(body['steps']) ?? {};
  for (const [group, flag] of [['models', '--step-model'], ['efforts', '--step-effort']] as const) {
    const map = obj(steps[group]) ?? {};
    for (const [step, value] of Object.entries(map)) {
      if (!STEP_NAMES[workflow].includes(step) || typeof value !== 'string' || !STEP_VALUE.test(value)) return { error: `invalid ${group} entry for ${step}` };
      argv.push(flag, `${step}=${value}`);
    }
  }
  const workspace = body['workspace'];
  const verify = body['verify'];
  if (workflow === 'plan-implement-review') {
    if (typeof workspace !== 'string' || workspace === '' || workspace.length > 1024 || workspace.includes('\0')) return { error: 'plan-implement-review needs a workspace path' };
    argv.push('--workspace', workspace);
    if (typeof verify === 'string' && verify !== '') {
      if (verify.length > 500) return { error: 'verify command is too long' };
      argv.push('--verify-command', verify);
    }
  }
  return { argv };
}

function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        resolve(undefined);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolve(undefined);
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): true {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
  res.end(body);
  return true;
}

function json(res: ServerResponse, status: number, value: unknown): true {
  return send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

export const QUOTA_STOP_PERCENT = 95;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_DIRS = 300;

/** The real-run argument vector for a previewed plan-review: the same arguments, confirmed instead of dry-run. */
export function toRunArgv(dryArgv: readonly string[]): string[] {
  return dryArgv.map((a) => (a === '--dry-run' ? '--confirm' : a));
}

const previewKey = (argv: readonly string[]): string => createHash('sha256').update(JSON.stringify(argv)).digest('hex');

/** Local-only server: dry-run preview, and a real plan-review run that needs a matching successful preview and explicit confirmation. */
export function createGuiServer(options: GuiOptions): Server & { readonly token: string; readonly shutdown: () => Promise<void> } {
  const token = options.token ?? randomBytes(24).toString('hex');
  const now = options.now ?? Date.now;
  const manager = new RunManager({ run: options.run, now, hide: [token] });
  const previews = new Map<string, number>();
  // Read-only CLI calls take turns instead of failing when two arrive together.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  function allowedHost(req: IncomingMessage): boolean {
    const port = String((server.address() as { port: number } | null)?.port ?? '');
    const host = req.headers.host;
    if (host === undefined || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${host}`;
  }

  const authed = (req: IncomingMessage): boolean => sameToken(req.headers['x-acl-token'] as string | undefined, token);
  const ask = async (argv: readonly string[]): Promise<string> => {
    let out = '';
    const code = await options.run(argv, { out: (t) => { out += t; }, error: () => undefined });
    return code === 0 ? out : '';
  };

  async function readJson(req: IncomingMessage): Promise<{ value: unknown } | { status: number; error: string }> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return { status: 415, error: 'JSON only' };
    const text = await readBody(req);
    if (text === undefined) return { status: 413, error: 'request too large' };
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { status: 400, error: 'invalid JSON' };
    }
  }

  async function startRun(body: unknown, res: ServerResponse): Promise<true> {
    if (obj(body)?.['confirm'] !== true) return json(res, 400, { error: 'explicit confirmation is required' });
    if (obj(body)?.['workflow'] !== 'plan-review') return json(res, 400, { error: 'only plan-review can run for real; plan-implement-review is preview only' });
    const built = buildDryRunArgv(body);
    if ('error' in built) return json(res, 400, { error: built.error });
    if (obj(body)?.['acceptUnverified'] === true && obj(body)?.['confirmAcceptUnverified'] !== true) {
      return json(res, 400, { error: '--accept-unverified also applies to the real run: it needs its own explicit confirmation' });
    }
    const cwd = obj(body)?.['cwd'];
    if (typeof cwd !== 'string' || cwd === '') return json(res, 400, { error: 'choose a project directory' });
    if (manager.active) return json(res, 409, { error: 'a run is already active' });
    const key = previewKey(built.argv);
    const expiry = previews.get(key);
    previews.delete(key);
    if (expiry === undefined || expiry < now()) return json(res, 409, { error: 'run a successful dry-run preview with exactly these settings first' });
    return exclusive(async () => {
      if (manager.active) return json(res, 409, { error: 'a run is already active' });
      const quota = parseQuota(await ask(['quota']));
      const full = quota.flatMap((q) => q.windows.map((w) => ({ provider: q.provider, ...w }))).find((w) => w.usedPercent >= QUOTA_STOP_PERCENT);
      if (full !== undefined) return json(res, 409, { error: `quota is almost used up (${full.provider} ${full.label}: ${String(full.usedPercent)}%); nothing was started` });
      const timeoutSec = obj(body)?.['timeoutSec'];
      const perStep = (typeof timeoutSec === 'number' ? timeoutSec : 600) * 1000;
      manager.start(toRunArgv(built.argv), [{ id: 'plan', provider: 'claude' }, { id: 'review', provider: 'codex' }], options.watchdogMs ?? perStep * 2 + 60_000);
      return json(res, 202, manager.snapshot());
    });
  }

  async function listDirs(url: URL, res: ServerResponse): Promise<true> {
    const asked = url.searchParams.get('path') ?? '';
    const path = asked === '' ? homedir() : asked;
    if (!isAbsolute(path) || path.length > 1024 || path.includes('\0')) return json(res, 400, { error: 'absolute path needed' });
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_DIRS);
      const parent = dirname(path);
      return json(res, 200, { path, parent: parent === path ? null : parent, dirs });
    } catch {
      return json(res, 400, { error: 'directory cannot be read' });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<true> {
    if (!allowedHost(req)) return json(res, 403, { error: 'host or origin not allowed' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/') {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, 'text/html; charset=utf-8', guiPage(token, nonce), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (!authed(req)) return json(res, 403, { error: 'missing or wrong token' });
    if (req.method === 'GET' && path === '/api/run') {
      const from = Number(url.searchParams.get('from') ?? '0');
      return json(res, 200, manager.snapshot(Number.isInteger(from) ? from : 0) ?? { status: 'idle' });
    }
    if (req.method === 'POST' && path === '/api/run/cancel') return json(res, 200, { cancelled: manager.cancel() });
    if (req.method === 'GET' && path === '/api/dirs') return listDirs(url, res);
    if (req.method === 'GET' && path === '/api/status') {
      if (manager.active) return json(res, 409, { error: 'a run is active' });
      return exclusive(async () => {
        if (manager.active) return json(res, 409, { error: 'a run is active' });
        const [providers, auth, quota, models] = [await ask(['providers']), await ask(['auth-status']), await ask(['quota']), await ask(['models'])];
        return json(res, 200, {
          providers: mergeLogin(parseProviderLines(providers), auth),
          quota: parseQuota(quota),
          quotaText: quota === '' ? 'unavailable' : quota.split('\n')[0] ?? '',
          models: parseModels(models),
        });
      });
    }
    if (req.method === 'POST' && (path === '/api/dry-run' || path === '/api/run')) {
      const body = await readJson(req);
      if ('error' in body) return json(res, body.status, { error: body.error });
      if (path === '/api/run') return startRun(body.value, res);
      const built = buildDryRunArgv(body.value);
      if ('error' in built) return json(res, 400, { error: built.error });
      if (manager.active) return json(res, 409, { error: 'a run is active' });
      return exclusive(async () => {
        if (manager.active) return json(res, 409, { error: 'a run is active' });
        let output = '';
        let errors = '';
        const exitCode = await options.run(built.argv, { out: (t) => { output += t; }, error: (t) => { errors += t; } });
        output = maskSecrets(output, [token]);
        errors = maskSecrets(errors, [token]);
        const view = parseDryRun(output);
        if (exitCode === 0 && view.verdict === 'would-run') {
          for (const [k, t] of previews) if (t < now()) previews.delete(k);
          if (previews.size >= 20) previews.clear();
          previews.set(previewKey(built.argv), now() + PREVIEW_TTL_MS);
        }
        return json(res, 200, { exitCode, output, errors, view });
      });
    }
    return json(res, 404, { error: 'not found' });
  }

  return Object.assign(server, { token, shutdown: () => manager.shutdown() });
}

/** Starts the server on the loopback interface only and resolves with its address. */
export function listenGui(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}
