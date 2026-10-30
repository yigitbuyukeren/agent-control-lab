import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isModelRouting, isPolicyName, isWorkflowName, type WorkflowName } from '@agent-control-lab/core';
import { guiPage } from './gui-page.ts';
import type { Io } from './main.ts';

export const GUI_DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASK_CHARS = 20_000;
const STEP_NAMES: Readonly<Record<WorkflowName, readonly string[]>> = {
  'plan-review': ['plan', 'review'],
  'plan-implement-review': ['plan', 'implement', 'review'],
};
const STEP_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Runs the real CLI with an argument vector; the GUI never gets any other way to start work. */
export type GuiRun = (argv: readonly string[], io: Io) => Promise<number>;

export interface GuiOptions {
  readonly run: GuiRun;
  /** Per-start secret that every API call must present; injectable for tests. */
  readonly token?: string;
}

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
  const argv = ['orchestrate', '--workflow', workflow, '--task', task, '--dry-run', '--no-record', '--policy', policy, '--model-routing', routing];
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

/** Local-only dry-run preview server. Nothing it receives or returns is stored. */
export function createGuiServer(options: GuiOptions): Server & { readonly token: string } {
  const token = options.token ?? randomBytes(24).toString('hex');
  let busy = false;
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<true> {
    if (!allowedHost(req)) return json(res, 403, { error: 'host or origin not allowed' });
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      const nonce = randomBytes(16).toString('base64');
      return send(res, 200, 'text/html; charset=utf-8', guiPage(token, nonce), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (req.method === 'POST' && path === '/api/dry-run') {
      if (!sameToken(req.headers['x-acl-token'] as string | undefined, token)) return json(res, 403, { error: 'missing or wrong token' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
      const text = await readBody(req);
      if (text === undefined) return json(res, 413, { error: 'request too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const built = buildDryRunArgv(parsed);
      if ('error' in built) return json(res, 400, { error: built.error });
      if (busy) return json(res, 429, { error: 'a preview is already running' });
      busy = true;
      try {
        let output = '';
        let errors = '';
        const exitCode = await options.run(built.argv, {
          out: (t) => {
            output += t;
          },
          error: (t) => {
            errors += t;
          },
        });
        return json(res, 200, { exitCode, output, errors });
      } finally {
        busy = false;
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  return Object.assign(server, { token });
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
