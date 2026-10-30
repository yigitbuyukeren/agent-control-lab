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

  describe('models', () => {
    const modelServer = (): AppServerProcess => {
      let lineCb: (line: string) => void = () => undefined;
      return {
        send: (line) => {
          const m = JSON.parse(line) as { id?: number; method: string; params?: { cursor?: string } };
          if (m.id === undefined) return;
          const result =
            m.method === 'initialize'
              ? {}
              : m.params?.cursor === 'p2'
                ? { data: [{ model: 'gpt-b', supportedReasoningEfforts: [] }], nextCursor: null }
                : {
                    data: [{ model: 'gpt-a', displayName: 'A', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
                    nextCursor: 'p2',
                  };
          queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, result })); });
        },
        onLine: (cb) => (lineCb = cb),
        onExit: () => undefined,
        kill: () => Promise.resolve(),
      };
    };
    const call = async (argv: string[]) => {
      let out = '';
      let error = '';
      const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, { appServer: modelServer });
      return { code, out, error };
    };

    it('lists documented Claude models as unverified and discovered Codex models with efforts', async () => {
      const r = await call(['models']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Claude Code (documented; account access not verified)');
      expect(r.out).toContain('claude-opus-5-5 (Opus 5.5): efforts unknown (documented levels: low, medium, high, xhigh, max)');
      expect(r.out).toContain('gpt-a (A): efforts low, medium, default medium');
      expect(r.out).toContain('gpt-b: efforts unknown');
      expect(r.out).toContain('ultracode is an optional work mode, not an effort level');
    });

    it('check distinguishes supported, unsupported and unknown via exit codes', async () => {
      expect(await call(['models', 'check', 'codex', 'gpt-a', 'medium'])).toMatchObject({ code: 0, out: 'supported (default)\n' });
      expect(await call(['models', 'check', 'codex', 'gpt-a', 'high'])).toMatchObject({ code: 1, out: 'unsupported (supported: low, medium)\n' });
      expect(await call(['models', 'check', 'codex', 'gpt-z', 'low'])).toMatchObject({ code: 3, out: 'unknown (model-not-listed)\n' });
      expect(await call(['models', 'check', 'claude', 'claude-opus-5-5', 'high'])).toMatchObject({ code: 3, out: 'unknown (efforts-not-known)\n' });
      expect(await call(['models', 'check', 'claude', 'claude-opus-5-5', 'ultracode'])).toMatchObject({ code: 3, out: 'unknown (invalid-effort)\n' });
    });

    it('rejects bad usage', async () => {
      expect((await call(['models', 'check', 'claude'])).code).toBe(2);
      expect((await call(['models', 'nope'])).code).toBe(2);
    });
  });

  describe('route --dry-run', () => {
    const NOW = new Date('2027-01-15T00:00:00Z');
    const exec: Exec = (command, args) => {
      if (args[0] === 'auth' || args[0] === 'login') {
        return Promise.resolve(
          command === 'claude'
            ? { kind: 'ok', stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }
            : { kind: 'ok', stdout: 'Logged in using ChatGPT' },
        );
      }
      return Promise.resolve({ kind: 'not-found' });
    };
    const appServer = (usedPercent: number, models: 'ok' | 'fail' = 'ok') => (): AppServerProcess => {
      let lineCb: (line: string) => void = () => undefined;
      return {
        send: (line) => {
          const m = JSON.parse(line) as { id?: number; method: string };
          if (m.id === undefined) return;
          let reply: object;
          if (m.method === 'account/rateLimits/read') {
            reply = { result: { rateLimits: { primary: { usedPercent, windowDurationMins: 300 }, secondary: { usedPercent, windowDurationMins: 10080 } } } };
          } else if (m.method === 'model/list') {
            reply =
              models === 'fail'
                ? { error: { code: -32603, message: 'secret me@example.com' } }
                : { result: { data: [{ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }], nextCursor: null } };
          } else {
            reply = { result: {} };
          }
          queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
        },
        onLine: (cb) => (lineCb = cb),
        onExit: () => undefined,
        kill: () => Promise.resolve(),
      };
    };
    const route = async (argv: string[], percent: number, models: 'ok' | 'fail' = 'ok') => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'acl-route-'));
      try {
        let out = '';
        let error = '';
        const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, { exec, cacheDir, now: () => NOW, appServer: appServer(percent, models) });
        return { code, out, error };
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    };

    it('recommends by task affinity and flags unknown Claude quota', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review'], 20);
      expect(r.code).toBe(0);
      expect(r.out).toContain('recommended: codex');
      expect(r.out).toContain('reason: task-affinity');
    });

    it('asks for manual selection when the preferred provider is exhausted', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review', '--prefer', 'codex'], 100);
      expect(r.out).toContain('manual-selection-required');
      expect(r.out).toContain('reason: preferred-quota-exhausted');
    });

    it('falls to the other provider when one is exhausted in auto mode', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review'], 100);
      expect(r.out).toContain('recommended: claude');
      expect(r.out).toContain('caveat: quota-unknown (claude)');
    });

    it('keeps a critical (95%) provider usable but flags it', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review', '--prefer', 'codex'], 96);
      expect(r.out).toContain('recommended: codex');
      expect(r.out).toContain('caveat: quota-critical (codex)');
    });

    it('keeps the old output unchanged when no model/effort/mode flags are given', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review'], 20);
      expect(r.out).not.toMatch(/model:|effort:|mode:|manual-approval/);
    });

    it('verifies a Codex model and the ultra effort against the live registry', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review', '--model', 'gpt-a', '--effort', 'ultra'], 20);
      expect(r.out).toContain('recommended: codex');
      expect(r.out).toContain('model: gpt-a (verified)');
      expect(r.out).toContain('effort: ultra (verified)');
      expect(r.out).toContain('manual-approval: not required');
    });

    it('reports model-not-listed and discovery failure as different things', async () => {
      const missing = await route(['route', '--dry-run', '--task', 'review', '--model', 'gpt-zzz'], 20);
      expect(missing.out).toContain('issue: model-not-listed [blocking] gpt-zzz');
      expect(missing.out).toContain('manual-approval: required');
      const down = await route(['route', '--dry-run', '--task', 'review', '--model', 'gpt-a'], 20, 'fail');
      expect(down.out).toContain('issue: model-discovery-failed [unverified] gpt-a (error: request was rejected)');
      expect(down.out).not.toContain('model-not-listed');
      expect(down.out).not.toMatch(/secret|example/);
    });

    it('selects ultracode only on request and requires approval for it', async () => {
      const r = await route(['route', '--dry-run', '--task', 'planning', '--prefer', 'claude', '--mode', 'ultracode'], 20);
      expect(r.out).toContain('recommended: claude');
      expect(r.out).toContain('mode: ultracode');
      expect(r.out).toContain('issue: mode-unverified [unverified] ultracode');
      expect(r.out).toContain('manual-approval: required');
      const normal = await route(['route', '--dry-run', '--task', 'planning', '--prefer', 'claude', '--model', 'auto', '--mode', 'normal'], 20);
      // Explicit defaults equal the default request, so the output stays as before.
      expect(normal.out).not.toMatch(/mode:|manual-approval/);
    });

    it('rejects ultracode as an effort and other bad selection flags', async () => {
      const ultracode = await route(['route', '--dry-run', '--task', 'review', '--effort', 'ultracode'], 20);
      expect(ultracode.code).toBe(2);
      expect(ultracode.error).toContain('use --mode ultracode');
      for (const extra of [['--mode', 'turbo'], ['--model', 'bad id!'], ['--effort', 'HIGH'], ['--model']]) {
        const r = await route(['route', '--dry-run', '--task', 'review', ...extra], 20);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
      }
    });

    it('requires --dry-run and a valid task and preference', async () => {
      for (const argv of [
        ['route', '--task', 'review'],
        ['route', '--dry-run'],
        ['route', '--dry-run', '--task', 'nope'],
        ['route', '--dry-run', '--task', 'review', '--prefer', 'x'],
        ['route', '--dry-run', '--task', 'review', '--run'],
      ]) {
        const r = await route(argv, 0);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
      }
    });
  });

  describe('quota all', () => {
    const NOW = new Date('2027-01-15T00:00:00Z');
    const codexServer = (): AppServerProcess => {
      let lineCb: (line: string) => void = () => undefined;
      return {
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
      };
    };

    it('shows both providers with used/left, reset, freshness and unknown', async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'acl-all-cli-'));
      try {
        const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: 1800000000 } } });
        await run(['statusline-collect'], { out: () => undefined, error: () => undefined }, { cacheDir, now: () => NOW, readStdin: () => Promise.resolve(input) });
        let out = '';
        const code = await run(['quota', 'all'], { out: (t) => (out += t), error: () => undefined }, { cacheDir, now: () => NOW, appServer: codexServer });
        expect(code).toBe(0);
        expect(out).toContain('Claude Code: ok (cache, fresh, updated 2027-01-15T00:00:00.000Z)');
        expect(out).toContain('5h window: 20% used, 80% left, resets 2027-01-15T08:00:00.000Z');
        expect(out).toContain('7d window: usage unknown, reset unknown');
        expect(out).toContain('Codex: ok (live, updated 2027-01-15T00:00:00.000Z, plan pro)');
        expect(out).toContain('5h window: 12% used, 88% left');
        expect(out).toContain('secondary window: usage unknown, reset unknown');
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });

    it('marks stale Claude data as unknown without counting it as 0', async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'acl-all-stale-'));
      try {
        const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: 1800000000 } } });
        await run(['statusline-collect'], { out: () => undefined, error: () => undefined }, { cacheDir, now: () => NOW, readStdin: () => Promise.resolve(input) });
        let out = '';
        const later = new Date(NOW.getTime() + 3_600_000);
        await run(['quota', 'all'], { out: (t) => (out += t), error: () => undefined }, { cacheDir, now: () => later, appServer: codexServer });
        expect(out).toContain('Claude Code: unknown (cache, stale, updated 2027-01-15T00:00:00.000Z)');
        expect(out).not.toContain('20% used');
        expect(out).not.toContain('0% used');
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
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
