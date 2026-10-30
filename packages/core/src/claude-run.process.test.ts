import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runClaude } from './claude-run.ts';
import { claudeRegistry } from './models.ts';
import { DEFAULT_REQUEST, resolveSelection } from './selection.ts';

const windows = process.platform === 'win32';
let bin = '';
let work = '';

// Fake `claude`: reports its argv (including the empty `--tools ""` value), stdin and env.
const FAKE = `
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (stdin.startsWith('HANG:')) {
    fs.writeFileSync(stdin.slice(5), String(process.pid));
    return;
  }
  const leaked = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE|AWS_|OPENAI_)/i.test(k) && k !== 'CLAUDE_CONFIG_DIR');
  console.log(JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), leaked }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'acl-fakeclaude-'));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'acl claude work ')));
  writeFileSync(join(bin, 'fake-claude.js'), FAKE);
  const file = join(bin, windows ? 'claude.cmd' : 'claude');
  writeFileSync(
    file,
    windows ? `@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "${join(bin, 'fake-claude.js')}" "$@"\n`,
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

const selection = resolveSelection('claude', { ...DEFAULT_REQUEST, model: 'claude-opus-5-5', effort: 'high' }, { claude: claudeRegistry, codex: { state: 'ok', models: [] } });

describe('runClaude through a real fake claude (cmd shim on Windows)', () => {
  it('keeps the empty --tools value, passes stdin and cwd (with spaces) and strips credentials', async () => {
    const outcome = await runClaude(
      { task: 'say hi & "quote"', cwd: work, selection, timeoutMs: 20_000 },
      { env: env({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', AWS_ACCESS_KEY_ID: 'a' }) },
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    const seen = JSON.parse(outcome.output) as { args: string[]; stdin: string; cwd: string; leaked: string[] };
    expect(seen.args).toEqual([
      '-p', '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
      '--permission-prompts', 'none', '--output-format', 'text', '--model', 'claude-opus-5-5', '--effort', 'high',
    ]);
    expect(seen.stdin).toBe('say hi & "quote"');
    expect(realpathSync(seen.cwd)).toBe(work);
    expect(seen.leaked).toEqual([]);
  });

  it('times out a hung claude and kills it', async () => {
    // The cleaned environment carries no test switches, so the fake hangs on a stdin marker.
    const pidFile = join(work, 'claude-hang.pid');
    const outcome = await runClaude({ task: `HANG:${pidFile}`, cwd: work, selection, timeoutMs: 5000 }, { env: env() });
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

  it('cancels a hung claude through the abort signal', async () => {
    const controller = new AbortController();
    const pidFile = join(work, 'claude-cancel.pid');
    const running = runClaude({ task: `HANG:${pidFile}`, cwd: work, selection, timeoutMs: 30_000, signal: controller.signal }, { env: env() });
    for (let i = 0; i < 200 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(pidFile)).toBe(true);
    controller.abort();
    expect(await running).toEqual({ kind: 'cancelled' });
  });

  it('reports not-installed when claude is not on PATH', async () => {
    const empty = join(work, 'nothing-here');
    expect(await runClaude({ task: 'x', cwd: work, selection, timeoutMs: 5000 }, { env: { ...env(), PATH: empty, Path: empty } })).toEqual({ kind: 'not-installed' });
  });
});
