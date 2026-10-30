import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverCodexModels } from './models.ts';
import { createAppServerSpawn, readCodexQuota } from './quota.ts';

const windows = process.platform === 'win32';
let dir = '';

// A fake `codex app-server`: answers the JSONL handshake, or hangs when ACL_FAKE_HANG is set.
const FAKE = `
const fs = require('node:fs');
fs.writeFileSync(process.env.ACL_PID_FILE, String(process.pid));
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (process.env.ACL_FAKE_HANG) continue;
    if (m.method === 'model/list') {
      const second = m.params && m.params.cursor === 'p2';
      console.log(JSON.stringify({ id: m.id, result: second
        ? { data: [{ model: 'gpt-b', supportedReasoningEfforts: [] }], nextCursor: null }
        : { data: [{ model: 'gpt-a', displayName: 'A', token: 'secret', defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: 'p2' } }));
    }
    if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (m.id === 2) console.log(JSON.stringify({ id: 2, result: { rateLimits: {
      planType: 'pro', primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1800000000 } } } }));
  }
});
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'acl-codex-'));
  writeFileSync(join(dir, 'fake-codex.js'), FAKE);
  const node = process.execPath;
  const file = join(dir, windows ? 'codex.cmd' : 'codex');
  writeFileSync(
    file,
    windows
      ? `@echo off\r\n"${node}" "%~dp0fake-codex.js" %*\r\n`
      : `#!/bin/sh\nexec "${node}" "${join(dir, 'fake-codex.js')}" "$@"\n`,
  );
  chmodSync(file, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== 'path') base[key] = value;
  }
  base['PATH'] = [dir, process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter);
  return { ...base, ...extra };
}

async function dead(pidFile: string): Promise<boolean> {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('real process via fake codex shim', () => {
  it('reads quota and cleans up the process (also through the Windows .cmd shim)', async () => {
    const pidFile = join(dir, 'ok.pid');
    const spawnServer = createAppServerSpawn({ env: env({ ACL_PID_FILE: pidFile }) });
    const status = await readCodexQuota(spawnServer, 15_000);
    expect(status).toMatchObject({ state: 'ok', plan: 'pro', primary: { usedPercent: 7, windowMinutes: 300 } });
    expect(existsSync(pidFile)).toBe(true);
    expect(await dead(pidFile)).toBe(true);
  });

  it('times out on a hung server and kills it', async () => {
    const pidFile = join(dir, 'hang.pid');
    const spawnServer = createAppServerSpawn({ env: env({ ACL_PID_FILE: pidFile, ACL_FAKE_HANG: '1' }) });
    expect(await readCodexQuota(spawnServer, 1500)).toEqual({ state: 'error', error: 'timed out' });
    expect(await dead(pidFile)).toBe(true);
  });

  it('discovers paginated models through the shim and cleans up', async () => {
    const pidFile = join(dir, 'models.pid');
    const spawnServer = createAppServerSpawn({ env: env({ ACL_PID_FILE: pidFile }) });
    const result = await discoverCodexModels(spawnServer, 15_000);
    expect(result.state === 'ok' && result.models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await dead(pidFile)).toBe(true);
  });

  it('times out model discovery on a hung server and kills it', async () => {
    const pidFile = join(dir, 'models-hang.pid');
    const spawnServer = createAppServerSpawn({ env: env({ ACL_PID_FILE: pidFile, ACL_FAKE_HANG: '1' }) });
    expect(await discoverCodexModels(spawnServer, 1500)).toEqual({ state: 'error', error: 'timed out' });
    expect(await dead(pidFile)).toBe(true);
  });

  it('reports not-installed when codex is not on PATH', async () => {
    const spawnServer = createAppServerSpawn({ env: { PATH: join(dir, 'empty') }, platform: process.platform });
    expect(await readCodexQuota(spawnServer, 3000)).toEqual({ state: 'not-installed' });
  });
});
