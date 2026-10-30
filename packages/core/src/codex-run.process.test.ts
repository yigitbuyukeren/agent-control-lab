import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCodex } from './codex-run.ts';
import { claudeRegistry, parseCodexModel, type ModelCapability } from './models.ts';
import { DEFAULT_REQUEST, resolveSelection } from './selection.ts';

const windows = process.platform === 'win32';
let bin = '';
let work = '';

// Fake `codex`: reports what it was given, or hangs when ACL_FAKE_HANG is set. No model is called.
const FAKE = `
const fs = require('node:fs');
if (process.env.ACL_PID_FILE) fs.writeFileSync(process.env.ACL_PID_FILE, String(process.pid));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (process.env.ACL_FAKE_HANG) return;
  console.log(JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), hasKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'acl-fakebin-'));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'acl work dir ')));
  writeFileSync(join(bin, 'fake-codex.js'), FAKE);
  const file = join(bin, windows ? 'codex.cmd' : 'codex');
  writeFileSync(
    file,
    windows
      ? `@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n`
      : `#!/bin/sh\nexec node "${join(bin, 'fake-codex.js')}" "$@"\n`,
  );
  chmodSync(file, 0o755);
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== 'path') base[key] = value;
  }
  base['PATH'] = [bin, process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter);
  return { ...base, ...extra };
}

const model = parseCodexModel({ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }) as ModelCapability;
const selection = resolveSelection('codex', { ...DEFAULT_REQUEST, model: 'gpt-a', effort: 'high' }, { claude: claudeRegistry, codex: { state: 'ok', models: [model] } });

describe('runCodex through a real fake codex (cmd shim on Windows)', () => {
  it('passes args, stdin and cwd (with spaces) and strips API-key variables', async () => {
    const outcome = await runCodex(
      { task: 'say hi & "quote"', cwd: work, selection, timeoutMs: 20_000 },
      { env: env({ OPENAI_API_KEY: 'sk-test', CODEX_API_KEY: 'sk-test2' }) },
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    const seen = JSON.parse(outcome.output) as { args: string[]; stdin: string; cwd: string; hasKey: boolean };
    expect(seen.args).toEqual(['exec', '-s', 'read-only', '--color', 'never', '--ephemeral', '-m', 'gpt-a', '-c', 'model_reasoning_effort=high', '-']);
    expect(seen.stdin).toBe('say hi & "quote"');
    expect(realpathSync(seen.cwd)).toBe(work);
    expect(seen.hasKey).toBe(false);
  });

  it('times out a hung codex and kills it', async () => {
    const pidFile = join(work, 'hang.pid');
    const outcome = await runCodex({ task: 'x', cwd: work, selection, timeoutMs: 1500 }, { env: env({ ACL_PID_FILE: pidFile, ACL_FAKE_HANG: '1' }) });
    expect(outcome).toEqual({ kind: 'timeout' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let dead = false;
    for (let i = 0; i < 60 && !dead; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
      }
    }
    expect(dead).toBe(true);
  });

  it('cancels a hung codex through the abort signal', async () => {
    const controller = new AbortController();
    const pidFile = join(work, 'cancel.pid');
    const running = runCodex({ task: 'x', cwd: work, selection, timeoutMs: 30_000, signal: controller.signal }, { env: env({ ACL_PID_FILE: pidFile, ACL_FAKE_HANG: '1' }) });
    for (let i = 0; i < 80 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    expect(await running).toEqual({ kind: 'cancelled' });
  });

  it('reports not-installed when codex is not on PATH', async () => {
    const empty = join(work, 'nothing-here');
    const outcome = await runCodex({ task: 'x', cwd: work, selection, timeoutMs: 5000 }, { env: { ...env(), PATH: empty, Path: empty } });
    expect(outcome).toEqual({ kind: 'not-installed' });
  });
});
