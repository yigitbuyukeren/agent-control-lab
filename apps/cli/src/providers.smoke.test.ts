import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/agent-control-lab.js', import.meta.url));
const windows = process.platform === 'win32';

let dir = '';

/** Writes a fake CLI that prints `stdout` and exits with `code` (a .cmd shim on Windows). */
function shim(name: string, stdout: string, code: number): void {
  const body = windows
    ? `@echo off\r\n${stdout === '' ? '' : `echo ${stdout}\r\n`}exit /b ${String(code)}\r\n`
    : `#!/bin/sh\n${stdout === '' ? '' : `echo '${stdout}'\n`}exit ${String(code)}\n`;
  const file = join(dir, windows ? `${name}.cmd` : name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function cli(command: string): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
  }
  env['PATH'] = [dir, process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter);
  return execFileSync(process.execPath, [bin, command], { env, encoding: 'utf8', timeout: 20000 });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'acl-shims-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('providers smoke (fake CLI shims on PATH)', () => {
  it('detects installed shims and reports a failing --version as an error', () => {
    shim('claude', '2.1.4 (fake)', 0);
    shim('codex', '', 1);
    const out = cli('providers');
    expect(out).toContain('Claude Code  installed 2.1.4');
    expect(out).not.toContain('not installed');
    expect(out).toMatch(/Codex\s+error: Command failed/);
  });

  it('auth-status parses shim output and never prints emails', () => {
    shim('claude', '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"me@example.com"}', 0);
    shim('codex', 'Not logged in', 1);
    const out = cli('auth-status');
    expect(out).toContain('Claude Code  logged in (subscription, pro)');
    expect(out).toContain('Codex        not logged in');
    expect(out).not.toContain('me@example.com');
  });
});
