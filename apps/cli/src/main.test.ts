import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppServerProcess, Exec } from '@agent-control-lab/core';
import { run, type Deps } from './main.ts';

async function capture(argv: string[], exec?: Exec) {
  let out = '';
  let error = '';
  const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, exec === undefined ? {} : { exec });
  return { code, out, error };
}

describe('cli', () => {
  it('prints the version', async () => {
    expect(await capture(['version'])).toMatchObject({ code: 0, out: '0.1.0\n' });
  });
  it('prints help by default', async () => {
    expect((await capture([])).out).toContain('Usage:');
  });
  it('prints info as JSON', async () => {
    const { out } = await capture(['info']);
    expect(JSON.parse(out)).toMatchObject({ name: 'agent-control-lab' });
  });
  it('fails on unknown commands', async () => {
    const r = await capture(['nope']);
    expect(r.code).toBe(2);
    expect(r.error).toContain('unknown command: nope');
  });
  it('lists providers using the injected exec only', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(command === 'claude' ? { kind: 'ok', stdout: '2.1.4 (Claude Code)' } : { kind: 'not-found' });
    const r = await capture(['providers'], exec);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Claude Code  installed 2.1.4');
    expect(r.out).toContain('Codex        not installed');
  });

  it('shows timeouts and failures as errors, not as not installed', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(command === 'claude' ? { kind: 'timeout' } : { kind: 'failed', detail: 'boom' });
    const { out } = await capture(['providers'], exec);
    expect(out).toContain('Claude Code  error: timed out after 5000 ms');
    expect(out).toContain('Codex        error: boom');
    expect(out).not.toContain('not installed');
  });

  it('shows auth state and method without raw output', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(
        command === 'claude'
          ? {
              kind: 'ok',
              stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"me@example.com"}',
            }
          : { kind: 'failed', detail: 'Command failed', stdout: 'Not logged in', stderr: '' },
      );
    const r = await capture(['auth-status'], exec);
    expect(r.out).toContain('Claude Code  logged in (subscription, pro)');
    expect(r.out).toContain('Codex        not logged in');
    expect(r.out).not.toContain('me@example.com');
  });

  it('prints quota windows, with unknown for missing data', async () => {
    let lineCb: (line: string) => void = () => undefined;
    const appServer = (): AppServerProcess => ({
      send: (line) => {
        const m = JSON.parse(line) as { id?: number };
        if (m.id === 1) queueMicrotask(() => { lineCb('{"id":1,"result":{}}'); });
        if (m.id === 2) {
          const result = { rateLimits: { planType: 'pro', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 } } };
          queueMicrotask(() => { lineCb(JSON.stringify({ id: 2, result })); });
        }
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    });
    let out = '';
    const code = await run(['quota'], { out: (t) => (out += t), error: () => undefined }, { appServer });
    expect(code).toBe(0);
    expect(out).toContain('Codex plan: pro');
    expect(out).toContain('5h window (primary): 12% used, resets 2027-01-15T08:00:00.000Z');
    expect(out).toContain('secondary: unknown');
  });

  it('quota claude --stdin shows only usage and reset times', async () => {
    const json = JSON.stringify({
      session_id: 'secret-session',
      workspace: { current_dir: '/home/me' },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1800000000, token: 'sk-secret' },
        seven_day: { used_percentage: 'bad' },
      },
    });
    let out = '';
    const code = await run(
      ['quota', 'claude', '--stdin'],
      { out: (t) => (out += t), error: () => undefined },
      { readStdin: () => Promise.resolve(json) },
    );
    expect(code).toBe(0);
    expect(out).toContain('5h window: 23.5% used, resets 2027-01-15T08:00:00.000Z');
    expect(out).toContain('7d window: unknown');
    expect(out).not.toMatch(/secret|home/);
  });

  it('quota claude rejects unknown flags and reports invalid input as unknown', async () => {
    expect((await capture(['quota', 'claude', '--bogus'])).code).toBe(2);
    expect((await capture(['quota', 'nope'])).code).toBe(2);
    let out = '';
    await run(['quota', 'claude', '--stdin'], { out: (t) => (out += t), error: () => undefined }, { readStdin: () => Promise.resolve('not json') });
    expect(out).toContain('Claude Code quota: unknown');
  });

  describe('statusline cache', () => {
    const input = JSON.stringify({
      session_id: 'secret-session',
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1800000000 },
        seven_day: { used_percentage: 60, resets_at: 1800500000 },
      },
    });
    const NOW = new Date('2027-01-15T00:00:00Z');

    async function withDir(test: (dir: string) => Promise<void>) {
      const dir = mkdtempSync(join(tmpdir(), 'acl-cli-'));
      try {
        await test(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    async function exec(argv: string[], deps: Deps) {
      let out = '';
      let error = '';
      const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, deps);
      return { code, out, error };
    }

    it('collects silently, then quota claude reads the cache', async () => {
      await withDir(async (cacheDir) => {
        const collect = await exec(['statusline-collect'], { cacheDir, now: () => NOW, readStdin: () => Promise.resolve(input) });
        expect(collect).toEqual({ code: 0, out: '', error: '' });
        const shown = await exec(['quota', 'claude'], { cacheDir, now: () => new Date(NOW.getTime() + 60_000) });
        expect(shown.out).toContain('5h window: 20% used');
        expect(shown.out).toContain('7d window: 60% used');
        expect(shown.out).toContain('updated 2027-01-15T00:00:00.000Z');
        expect(shown.out).not.toContain('secret');
      });
    });

    it('shows unknown for stale or missing cache and keeps bad input from overwriting', async () => {
      await withDir(async (cacheDir) => {
        expect((await exec(['quota', 'claude'], { cacheDir, now: () => NOW })).out).toContain('Claude Code quota: unknown');
        await exec(['statusline-collect'], { cacheDir, now: () => NOW, readStdin: () => Promise.resolve(input) });
        await exec(['statusline-collect'], { cacheDir, now: () => NOW, readStdin: () => Promise.resolve('garbage') });
        const stale = await exec(['quota', 'claude'], { cacheDir, now: () => new Date(NOW.getTime() + 3_600_000) });
        expect(stale.out).toContain('Claude Code quota: unknown');
        const fresh = await exec(['quota', 'claude'], { cacheDir, now: () => NOW });
        expect(fresh.out).toContain('5h window: 20% used');
      });
    });

    it('reports a fixed error when the cache cannot be written', async () => {
      await withDir(async (cacheDir) => {
        const blocker = join(cacheDir, 'file');
        writeFileSync(blocker, 'x');
        const r = await exec(['statusline-collect'], { cacheDir: blocker, now: () => NOW, readStdin: () => Promise.resolve(input) });
        expect(r).toEqual({ code: 1, out: '', error: 'could not write the quota cache\n' });
      });
    });
  });
});
