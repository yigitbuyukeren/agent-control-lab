import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  discoverWorkspaces,
  suggestWorkspace,
  claudeSettingsPath,
  decodeChain,
  diagnoseClaudeIntegration,
  installCollector,
  isModelRouting,
  isPolicyName,
  isWorkflowName,
  PERMISSION_PROFILES,
  resolveCacheDir,
  uninstallCollector,
  type InstallResult,
  type IntegrationDiagnosis,
  type IntegrationPaths,
  type UninstallResult,
  type WorkflowName,
} from '@agent-control-lab/core';
import { guiPage } from './gui-page.ts';
import { mergeLogin, parseDryRun, parseModels, parseProviderLines, parseQuota } from './gui-model.ts';
import { RunManager, type GuiRun } from './gui-run.ts';
import { maskSecrets } from './gui-secrets.ts';
import { gitWorkspaceProbe, type WorkspaceProbe } from './gui-workspace.ts';

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
  /** Claude Code quota collector; absent in tests that do not need it. */
  readonly claude?: ClaudeIntegration;
  /** Hard ceiling for a whole run in ms; defaults to the per-step timeout times the steps plus a minute. */
  readonly watchdogMs?: number;
  /** Read-only Git view of a workspace for plan-implement-review; defaults to the real one. */
  readonly workspace?: WorkspaceProbe;
}

export type { GuiRun } from './gui-run.ts';

/** The Claude Code quota collector: read what is there, and (only on explicit request) wire it in or take it out. */
export interface ClaudeIntegration {
  readonly diagnose: () => Promise<IntegrationDiagnosis>;
  readonly install: () => Promise<InstallResult>;
  readonly uninstall: () => Promise<UninstallResult>;
}

export function fileClaudeIntegration(paths: IntegrationPaths, now: () => Date = () => new Date()): ClaudeIntegration {
  return {
    diagnose: () => diagnoseClaudeIntegration(paths, now()),
    install: () => installCollector(paths, now()),
    uninstall: () => uninstallCollector(paths),
  };
}

/** The real paths: the user's own settings file and the existing quota cache directory. */
export function defaultClaudePaths(binPath: string): IntegrationPaths {
  return { settingsPath: claudeSettingsPath(), cacheDir: resolveCacheDir(), nodePath: process.execPath, binPath };
}

const planId = (command: string): string => createHash('sha256').update(command).digest('hex').slice(0, 16);

/** The page never sees the raw command: a chained original is decoded for reading and masked. */
function publicDiagnosis(d: IntegrationDiagnosis): Record<string, unknown> {
  const { plan, ...rest } = d;
  if (plan === undefined) return rest;
  const display = plan.command.replace(/ --chain (\S+)/, (_m, enc: string) => {
    const original = decodeChain(enc);
    return original === undefined ? '' : ` --chain «${maskSecrets(original)}»`;
  });
  return { ...rest, plan: { action: plan.action, display, id: planId(plan.command) } };
}

type Built = { readonly argv: string[] } | { readonly error: string };

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The providers of plan and review that a built argv will use: the chosen ones, otherwise the workflow's
 * defaults. For plan-implement-review the implementation (default Codex) is the middle entry.
 */
export function chosenProviders(argv: readonly string[], workflow: WorkflowName = 'plan-review'): ('claude' | 'codex')[] {
  const pick = (step: string, fallback: 'claude' | 'codex'): 'claude' | 'codex' => {
    const at = argv.findIndex((a, i) => argv[i - 1] === '--step-provider' && a.startsWith(`${step}=`));
    const value = at < 0 ? undefined : argv[at]?.slice(step.length + 1);
    return value === 'claude' || value === 'codex' ? value : fallback;
  };
  return workflow === 'plan-review' ? [pick('plan', 'claude'), pick('review', 'codex')] : [pick('plan', 'claude'), pick('implement', 'codex'), pick('review', 'claude')];
}

/** The steps a real run will report, in the CLI's own order; local steps are shown but never use a provider. */
export function runStepsFor(workflow: WorkflowName, argv: readonly string[], verify: boolean): { id: string; provider: string }[] {
  const used = chosenProviders(argv, workflow);
  if (workflow === 'plan-review') return [{ id: 'plan', provider: used[0] ?? 'claude' }, { id: 'review', provider: used[1] ?? 'codex' }];
  return [
    { id: 'plan', provider: used[0] ?? 'claude' },
    { id: 'implement', provider: used[1] ?? 'codex' },
    { id: 'inspect', provider: 'local' },
    ...(verify ? [{ id: 'verify', provider: 'local' }] : []),
    { id: 'review', provider: used[2] ?? 'claude' },
  ];
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
  const providers = obj(steps['providers']) ?? {};
  for (const [step, value] of Object.entries(providers)) {
    if (!STEP_NAMES[workflow].includes(step) || typeof value !== 'string' || !['auto', 'claude', 'codex'].includes(value)) return { error: `invalid provider for ${step}` };
    argv.push('--step-provider', `${step}=${value}`);
  }
  const profiles = obj(steps['profiles']) ?? {};
  for (const [step, value] of Object.entries(profiles)) {
    if (!STEP_NAMES[workflow].includes(step) || typeof value !== 'string' || !['auto', ...PERMISSION_PROFILES].includes(value)) return { error: `invalid permission profile for ${step}` };
    argv.push('--step-profile', `${step}=${value}`);
  }
  for (const [group, flag] of [['models', '--step-model'], ['efforts', '--step-effort']] as const) {
    const map = obj(steps[group]) ?? {};
    for (const [step, value] of Object.entries(map)) {
      if (!STEP_NAMES[workflow].includes(step) || typeof value !== 'string' || !STEP_VALUE.test(value)) return { error: `invalid ${group} entry for ${step}` };
      argv.push(flag, `${step}=${value}`);
    }
  }
  if (body['withInstructions'] === true) argv.push('--with-instructions');
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
export function toRunArgv(dryArgv: readonly string[], confirmVerify = false, unsandboxed = false): string[] {
  const write = dryArgv.includes('--workspace');
  const argv = dryArgv.map((a) => (a === '--dry-run' ? (write ? '--confirm-write' : '--confirm') : a));
  return write && confirmVerify && argv.includes('--verify-command') ? [...argv, '--confirm-verify', ...(unsandboxed ? ['--verify-unsandboxed'] : [])] : argv;
}

const previewKey = (argv: readonly string[]): string => createHash('sha256').update(JSON.stringify(argv)).digest('hex');

/** Local-only server: dry-run preview, and a real plan-review run that needs a matching successful preview and explicit confirmation. */
export function createGuiServer(options: GuiOptions): Server & { readonly token: string; readonly shutdown: () => Promise<void> } {
  const token = options.token ?? randomBytes(24).toString('hex');
  const now = options.now ?? Date.now;
  const manager = new RunManager({ run: options.run, now, hide: [token] });
  const probe = options.workspace ?? gitWorkspaceProbe();
  /** Preview key to its expiry and, for a write workflow, the workspace fingerprint the preview was taken against. */
  const previews = new Map<string, { expiry: number; fingerprint?: string }>();
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

  const runCli = async (argv: readonly string[]): Promise<{ exitCode: number; output: string; errors: string }> => {
    let output = '';
    let errors = '';
    const exitCode = await options.run(argv, { out: (t) => { output += t; }, error: (t) => { errors += t; } });
    return { exitCode, output, errors };
  };
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
    const b = obj(body);
    if (b?.['confirm'] !== true) return json(res, 400, { error: 'explicit confirmation is required' });
    const workflow = b['workflow'];
    if (workflow !== 'plan-review' && workflow !== 'plan-implement-review') return json(res, 400, { error: 'unknown workflow' });
    const built = buildDryRunArgv(body);
    if ('error' in built) return json(res, 400, { error: built.error });
    if (b['acceptUnverified'] === true && b['confirmAcceptUnverified'] !== true) {
      return json(res, 400, { error: '--accept-unverified also applies to the real run: it needs its own explicit confirmation' });
    }
    const write = workflow === 'plan-implement-review';
    const where = write ? b['workspace'] : b['cwd'];
    if (typeof where !== 'string' || where === '') return json(res, 400, { error: write ? 'choose the linked worktree' : 'choose a project directory' });
    if (write && !isAbsolute(where)) return json(res, 400, { error: 'the worktree must be an absolute path' });
    if (write && b['confirmWrite'] !== true) return json(res, 400, { error: 'plan-implement-review writes files: it needs its own explicit write confirmation' });
    const verify = write && typeof b['verify'] === 'string' && b['verify'] !== '';
    if (verify && b['confirmVerify'] !== true) return json(res, 400, { error: 'the test command runs newly written code: it needs its own explicit confirmation' });
    if (manager.active) return json(res, 409, { error: 'a run is already active' });
    const key = previewKey(built.argv);
    const preview = previews.get(key);
    previews.delete(key);
    if (preview === undefined || preview.expiry < now()) return json(res, 409, { error: 'run a successful dry-run preview with exactly these settings first' });
    return exclusive(async () => {
      if (manager.active) return json(res, 409, { error: 'a run is already active' });
      let before: Awaited<ReturnType<WorkspaceProbe['read']>>;
      if (write) {
        before = await probe.read(where);
        if (before === undefined) return json(res, 409, { error: 'the worktree state cannot be read; nothing was started' });
        if (before.fingerprint !== preview.fingerprint) return json(res, 409, { error: 'the worktree changed since the preview; run the preview again' });
      }
      const used = chosenProviders(built.argv, workflow);
      const quota = parseQuota(await ask(['quota']));
      const full = quota.filter((q) => used.includes(q.provider)).flatMap((q) => q.windows.map((w) => ({ provider: q.provider, ...w }))).find((w) => w.usedPercent >= QUOTA_STOP_PERCENT);
      if (full !== undefined) return json(res, 409, { error: `quota is almost used up (${full.provider} ${full.label}: ${String(full.usedPercent)}%); nothing was started` });
      const claudeNow = options.claude === undefined || !used.includes('claude') ? undefined : await options.claude.diagnose();
      for (const [label, w] of [['5h window', claudeNow?.fiveHour], ['7d window', claudeNow?.sevenDay]] as const) {
        if (w?.usedPercent !== undefined && w.usedPercent >= QUOTA_STOP_PERCENT) return json(res, 409, { error: `quota is almost used up (claude ${label}: ${String(w.usedPercent)}%); nothing was started` });
      }
      const timeoutSec = b['timeoutSec'];
      const perStep = (typeof timeoutSec === 'number' ? timeoutSec : 600) * 1000;
      const steps = runStepsFor(workflow, built.argv, verify);
      const timed = steps.filter((st) => st.provider !== 'local').length + (verify ? 1 : 0);
      manager.start(toRunArgv(built.argv, verify, b['confirmUnsandboxed'] === true), steps, options.watchdogMs ?? perStep * timed + 60_000, write ? () => probe.report(where, before) : undefined);
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
    if (req.method === 'POST' && path === '/api/workspaces') {
      const body = await readJson(req);
      if ('error' in body) return json(res, body.status, { error: body.error });
      const input = obj(body.value);
      const root = input?.['root'];
      const task = input?.['task'];
      if (typeof root !== 'string' || !isAbsolute(root) || root.length > 1024 || root.includes('\0')) return json(res, 400, { error: 'absolute root path needed' });
      if (task !== undefined && (typeof task !== 'string' || task.length > 20000)) return json(res, 400, { error: 'task must be text' });
      const found = await discoverWorkspaces(root);
      if ('error' in found) return json(res, 400, { error: found.error });
      const suggestion = typeof task === 'string' && task.trim() !== '' ? suggestWorkspace(task, found.candidates) : undefined;
      return json(res, 200, { ...found, ...(suggestion === undefined ? {} : { suggestion }) });
    }
    if (path === '/api/claude' && req.method === 'GET') {
      return json(res, 200, options.claude === undefined ? { unavailable: true } : publicDiagnosis(await options.claude.diagnose()));
    }
    if (req.method === 'POST' && (path === '/api/claude/install' || path === '/api/claude/uninstall')) {
      const claude = options.claude;
      const body = await readJson(req);
      if ('error' in body) return json(res, body.status, { error: body.error });
      const input = obj(body.value);
      if (claude === undefined) return json(res, 400, { error: 'not available' });
      if (input?.['confirm'] !== true) return json(res, 400, { error: 'explicit confirmation is required' });
      return exclusive(async () => {
        if (path === '/api/claude/install') {
          const before = await claude.diagnose();
          if (before.plan === undefined) return json(res, 409, { error: 'nothing can be installed', diagnosis: publicDiagnosis(before) });
          if (input['planId'] !== planId(before.plan.command)) return json(res, 409, { error: 'the plan changed since you reviewed it; reload and review it again' });
          const result = await claude.install();
          return json(res, result.ok ? 200 : 409, { ...(result.ok ? {} : { error: result.reason }), result, diagnosis: publicDiagnosis(await claude.diagnose()) });
        }
        const result = await claude.uninstall();
        return json(res, result.ok ? 200 : 409, { ...(result.ok ? {} : { error: result.reason }), result, diagnosis: publicDiagnosis(await claude.diagnose()) });
      });
    }
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
        let runnable = false;
        if (exitCode === 0 && view.verdict === 'would-run') {
          const wsIndex = built.argv.indexOf('--workspace');
          const state = wsIndex < 0 ? undefined : await probe.read(built.argv[wsIndex + 1] ?? '');
          // A write workflow is only runnable against a workspace whose state could be read now.
          if (wsIndex < 0 || state !== undefined) {
            for (const [k, v] of previews) if (v.expiry < now()) previews.delete(k);
            if (previews.size >= 20) previews.clear();
            previews.set(previewKey(built.argv), { expiry: now() + PREVIEW_TTL_MS, ...(state === undefined ? {} : { fingerprint: state.fingerprint }) });
            runnable = true;
          }
        }
        // `runnable` is true only when a real run could follow: the CLI said it would run and, for a write workflow, the worktree state could be read.
        return json(res, 200, { exitCode, output, errors, view, runnable });
      });
    }
    if (req.method === 'GET' && (path === '/api/doctor' || path === '/api/tasks')) {
      if (manager.active) return json(res, 409, { error: 'a run is active' });
      return exclusive(async () => {
        const r = await runCli(path === '/api/doctor' ? ['doctor', '--json'] : ['tasks', 'list', '--json']);
        try {
          return json(res, 200, { items: JSON.parse(r.output) as unknown });
        } catch {
          return json(res, 200, { items: [], error: 'unavailable' });
        }
      });
    }
    if (req.method === 'POST' && (path === '/api/instructions' || path === '/api/worktree')) {
      const body = await readJson(req);
      if ('error' in body) return json(res, body.status, { error: body.error });
      const input = obj(body.value);
      const dir = input?.[path === '/api/worktree' ? 'repo' : 'cwd'];
      if (typeof dir !== 'string' || !isAbsolute(dir) || dir.length > 1024 || dir.includes('\0')) return json(res, 400, { error: 'absolute path needed' });
      if (manager.active) return json(res, 409, { error: 'a run is active' });
      if (path === '/api/instructions') {
        return exclusive(async () => {
          const r = await runCli(['instructions', '--cwd', dir, '--json']);
          try {
            return json(res, 200, JSON.parse(r.output) as unknown);
          } catch {
            return json(res, 400, { error: 'could not read the instructions' });
          }
        });
      }
      const create = input?.['confirm'] === true;
      return exclusive(async () => {
        const r = await runCli(['worktree', 'create', '--repo', dir, ...(create ? ['--confirm'] : [])]);
        const workspace = /--workspace "([^"]+)"/.exec(r.output)?.[1];
        return json(res, 200, { exitCode: r.exitCode, output: maskSecrets(r.output, [token]), errors: maskSecrets(r.errors, [token]), created: create && r.exitCode === 0, ...(create && r.exitCode === 0 && workspace !== undefined ? { workspace } : {}) });
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
