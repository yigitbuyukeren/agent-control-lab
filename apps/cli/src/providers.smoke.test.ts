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

  it('quota claude --stdin reads piped statusLine JSON on this platform', () => {
    const input = JSON.stringify({
      cwd: 'secret-dir',
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 1800000000 }, seven_day: { used_percentage: 55, resets_at: 1800500000 } },
    });
    const out = execFileSync(process.execPath, [bin, 'quota', 'claude', '--stdin'], {
      input,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(out).toContain('5h window: 10% used, resets 2027-01-15T08:00:00.000Z');
    expect(out).toContain('7d window: 55% used');
    expect(out).not.toContain('secret');
  });

  it('statusline-collect then quota claude work through the real binary with an isolated cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'acl-smoke-cache-'));
    try {
      const env = { ...process.env, ACL_CACHE_DIR: cache };
      const now = Math.floor(Date.now() / 1000);
      const input = JSON.stringify({
        session_id: 'secret-session',
        rate_limits: {
          five_hour: { used_percentage: 33, resets_at: now + 3600 },
          seven_day: { used_percentage: 44, resets_at: now + 86400 },
        },
      });
      const collected = execFileSync(process.execPath, [bin, 'statusline-collect'], { input, env, encoding: 'utf8', timeout: 20000 });
      expect(collected).toBe('');
      const out = execFileSync(process.execPath, [bin, 'quota', 'claude'], { env, encoding: 'utf8', timeout: 20000 });
      expect(out).toContain('5h window: 33% used');
      expect(out).toContain('7d window: 44% used');
      expect(out).not.toContain('secret');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('quota all works through the real binary when codex is missing from PATH', () => {
    const cache = mkdtempSync(join(tmpdir(), 'acl-smoke-all-'));
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
      }
      env['PATH'] = join(cache, 'no-binaries-here');
      env['ACL_CACHE_DIR'] = cache;
      const now = Math.floor(Date.now() / 1000);
      const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 25, resets_at: now + 3600 } } });
      execFileSync(process.execPath, [bin, 'statusline-collect'], { input, env, encoding: 'utf8', timeout: 20000 });
      const out = execFileSync(process.execPath, [bin, 'quota', 'all'], { env, encoding: 'utf8', timeout: 20000 });
      expect(out).toContain('Claude Code: ok (cache, fresh');
      expect(out).toContain('5h window: 25% used, 75% left');
      expect(out).toContain('7d window: usage unknown, reset unknown');
      expect(out).toContain('Codex: not installed');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('route --dry-run asks for manual selection when no provider is on PATH', () => {
    const cache = mkdtempSync(join(tmpdir(), 'acl-smoke-route-'));
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
      }
      env['PATH'] = join(cache, 'no-binaries-here');
      env['ACL_CACHE_DIR'] = cache;
      const out = execFileSync(process.execPath, [bin, 'route', '--dry-run', '--task', 'review'], { env, encoding: 'utf8', timeout: 20000 });
      expect(out).toContain('manual-selection-required');
      expect(out).toContain('reason: no-available-provider');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('models lists the documented Claude registry and reports Codex not installed when absent', () => {
    const cache = mkdtempSync(join(tmpdir(), 'acl-smoke-models-'));
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
      }
      env['PATH'] = join(cache, 'no-binaries-here');
      const out = execFileSync(process.execPath, [bin, 'models'], { env, encoding: 'utf8', timeout: 20000 });
      expect(out).toContain('documented; account access not verified');
      expect(out).toContain('claude-opus-5-5');
      expect(out).toContain('not installed');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('route rejects ultracode as an effort through the real binary', () => {
    expect(() =>
      execFileSync(process.execPath, [bin, 'route', '--dry-run', '--task', 'review', '--effort', 'ultracode'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 20000,
      }),
    ).toThrow(/use --mode ultracode/);
  });
});
