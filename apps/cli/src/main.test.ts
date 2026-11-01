import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppServerProcess, Exec, GitState, ProcessOutcome, ProcessSpec, SettingsScan } from '@agent-control-lab/core';
import { run, type Deps } from './main.ts';
import { claudeJson } from './claude-json-fixture.ts';

async function capture(argv: string[], exec?: Exec) {
  let out = '';
  let error = '';
  const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, exec === undefined ? {} : { exec });
  return { code, out, error };
}

describe('cli', () => {
  it('prints the version', async () => {
    expect(await capture(['version'])).toMatchObject({ code: 0, out: '1.0.0\n' });
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

  describe('run --provider codex', () => {
    const loginExec = (output: string, kind: 'ok' | 'failed' | 'not-found' = 'ok'): Exec => () =>
      Promise.resolve(
        kind === 'ok' ? { kind: 'ok', stdout: output } : kind === 'failed' ? { kind: 'failed', detail: 'x', stdout: output, stderr: '' } : { kind: 'not-found' },
      );
    const modelServer = (mode: 'ok' | 'fail' = 'ok') => (): AppServerProcess => {
      let lineCb: (line: string) => void = () => undefined;
      return {
        send: (line) => {
          const m = JSON.parse(line) as { id?: number; method: string };
          if (m.id === undefined) return;
          const reply =
            m.method === 'model/list' && mode === 'fail'
              ? { error: { code: 1, message: 'secret' } }
              : m.method === 'model/list'
                ? { result: { data: [{ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }], nextCursor: null } }
                : { result: {} };
          queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
        },
        onLine: (cb) => (lineCb = cb),
        onExit: () => undefined,
        kill: () => Promise.resolve(),
      };
    };
    const START = ['run', '--provider', 'codex', '--task', 'summarize the repo', '--confirm'];

    async function go(
      argv: string[],
      over: { exec?: Exec; outcome?: ProcessOutcome; models?: 'ok' | 'fail'; git?: GitState } = {},
    ) {
      const specs: ProcessSpec[] = [];
      let out = '';
      let error = '';
      const dir = mkdtempSync(join(tmpdir(), 'acl-run-'));
      try {
        const code = await run(
          argv.map((a) => (a === '@cwd' ? dir : a)),
          { out: (t) => (out += t), error: (t) => (error += t) },
          {
            exec: over.exec ?? loginExec('Logged in using ChatGPT'),
            appServer: modelServer(over.models),
            cwd: dir,
            git: () => Promise.resolve(over.git ?? 'repo'),
            runner: (spec) => {
              specs.push(spec);
              return Promise.resolve(over.outcome ?? { kind: 'completed', exitCode: 0, stdout: 'answer\n', truncated: false });
            },
          },
        );
        return { code, out, error, specs, dir };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('runs read-only with an explicit cwd and prints only the answer on stdout', async () => {
      const r = await go(START);
      expect(r.code).toBe(0);
      expect(r.out).toBe('answer\n');
      expect(r.error).toContain('read-only sandbox, subscription login');
      expect(r.error).toContain('model: provider-default');
      expect(r.specs).toHaveLength(1);
      expect(r.specs[0]).toMatchObject({ command: 'codex', input: 'summarize the repo' });
      expect(r.specs[0]?.args).toEqual(['exec', '-s', 'read-only', '--color', 'never', '--ephemeral', '-']);
      expect(r.specs[0]?.cwd).toBeTruthy();
    });

    it('verifies a pinned model and the ultra effort, passing both through', async () => {
      const r = await go([...START, '--model', 'gpt-a', '--effort', 'ultra']);
      expect(r.code).toBe(0);
      expect(r.specs[0]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=ultra']));
      expect(r.error).toContain('model: gpt-a (verified)');
    });

    it('refuses without --confirm, for other providers and for bad options, never spawning', async () => {
      for (const argv of [
        START.filter((a) => a !== '--confirm'),
        ['run', '--provider', 'openai', '--task', 'x', '--confirm'],
        ['run', '--task', 'x', '--confirm'],
        ['run', '--provider', 'codex', '--confirm'],
        [...START, '--mode', 'ultracode'],
        [...START, '--effort', 'ultracode'],
        [...START, '--timeout', '0'],
        [...START, '--timeout', '999999'],
        [...START, '--model', 'bad id!'],
        [...START, '--sandbox', 'danger-full-access'],
      ]) {
        const r = await go(argv);
        expect(r.code).toBe(2);
        expect(r.specs).toHaveLength(0);
        expect(r.out).toBe('');
      }
    });

    it('refuses API-key, logged-out, missing and unknown logins without any fallback', async () => {
      const cases: [Exec, string][] = [
        [loginExec('Logged in using an API key - sk-abc***'), 'codex is logged in with an API key; only a subscription login is allowed'],
        [loginExec('Not logged in', 'failed'), 'codex is not logged in'],
        [loginExec('', 'not-found'), 'codex is not installed'],
        [loginExec('something new'), 'codex login state could not be determined'],
      ];
      for (const [exec, message] of cases) {
        const r = await go(START, { exec });
        expect(r.code).toBe(1);
        expect(r.error).toContain(`run refused: ${message}`);
        expect(r.error).not.toContain('sk-abc');
        expect(r.specs).toHaveLength(0);
      }
    });

    it('applies blocking selection rules but only warns on unverifiable ones', async () => {
      const missing = await go([...START, '--model', 'gpt-zzz']);
      expect(missing.code).toBe(1);
      expect(missing.error).toContain('issue: model-not-listed [blocking] gpt-zzz');
      expect(missing.specs).toHaveLength(0);
      const unsupported = await go([...START, '--model', 'gpt-a', '--effort', 'max']);
      expect(unsupported.error).toContain('effort-unsupported [blocking]');
      expect(unsupported.specs).toHaveLength(0);
      const down = await go([...START, '--model', 'gpt-a', '--accept-unverified'], { models: 'fail' });
      expect(down.code).toBe(0);
      expect(down.error).toContain('warning: model-discovery-failed');
      expect(down.error).not.toContain('secret');
      expect(down.specs).toHaveLength(1);
    });

    it('requires --accept-unverified for unverifiable selections, and never lets it override blocking ones', async () => {
      const noAccept = await go([...START, '--model', 'gpt-a'], { models: 'fail' });
      expect(noAccept.code).toBe(1);
      expect(noAccept.error).toContain('add --accept-unverified to run anyway');
      expect(noAccept.error).toContain('issue: model-discovery-failed');
      expect(noAccept.specs).toHaveLength(0);
      const effortOnly = await go([...START, '--effort', 'low']);
      expect(effortOnly.code).toBe(1);
      expect(effortOnly.error).toContain('effort-unverified');
      const accepted = await go([...START, '--effort', 'low', '--accept-unverified']);
      expect(accepted.code).toBe(0);
      expect(accepted.error).toContain('warning: effort-unverified');
      for (const extra of [['--model', 'gpt-zzz'], ['--model', 'gpt-a', '--effort', 'max']]) {
        const blocked = await go([...START, ...extra, '--accept-unverified']);
        expect(blocked.code).toBe(1);
        expect(blocked.error).toContain('[blocking]');
        expect(blocked.specs).toHaveLength(0);
      }
      const clean = await go(START);
      expect(clean.code).toBe(0);
    });

    it('requires a Git repository and explains how to fix it without initialising anything', async () => {
      for (const [git, message] of [
        ['not-a-repo', 'not inside a Git repository'],
        ['git-not-installed', 'git is not installed'],
        ['check-failed', 'Git repository check failed'],
      ] as const) {
        const r = await go(START, { git });
        expect(r.code).toBe(1);
        expect(r.error).toContain(message);
        expect(r.specs).toHaveLength(0);
      }
      const hint = await go(START, { git: 'not-a-repo' });
      expect(hint.error).toContain('Run `git init` yourself');
    });

    it('dry-run prints the plan, starts nothing and needs no --confirm', async () => {
      const r = await go(['run', '--provider', 'codex', '--task', 'summarize the repo', '--dry-run', '--model', 'gpt-a', '--effort', 'low']);
      expect(r.code).toBe(0);
      expect(r.specs).toHaveLength(0);
      expect(r.out).toContain('run plan (dry run, no agent started)');
      expect(r.out).toContain('git: repo');
      expect(r.out).toContain('sandbox: read-only');
      expect(r.out).toContain('login: subscription login');
      expect(r.out).toContain('model: gpt-a (verified)');
      expect(r.out).toContain('task: 18 characters');
      expect(r.out).toContain('requires: --confirm\n');
      expect(r.out).toContain('verdict: would run');
      expect(r.out).not.toContain('summarize');
    });

    it('dry-run reports refusals with exit 1, including needed acceptance flags', async () => {
      const outside = await go(['run', '--provider', 'codex', '--task', 'x', '--dry-run'], { git: 'not-a-repo' });
      expect(outside.code).toBe(1);
      expect(outside.out).toContain('verdict: would refuse: the working directory is not inside a Git repository');
      expect(outside.specs).toHaveLength(0);
      const unverified = await go(['run', '--provider', 'codex', '--task', 'x', '--dry-run', '--model', 'gpt-a'], { models: 'fail' });
      expect(unverified.code).toBe(1);
      expect(unverified.out).toContain('requires: --confirm, --accept-unverified');
      expect(unverified.out).toContain('would refuse: the model/effort selection could not be verified');
      const accepted = await go(['run', '--provider', 'codex', '--task', 'x', '--dry-run', '--model', 'gpt-a', '--accept-unverified'], { models: 'fail' });
      expect(accepted.code).toBe(0);
      const blocked = await go(['run', '--provider', 'codex', '--task', 'x', '--dry-run', '--model', 'gpt-zzz', '--accept-unverified']);
      expect(blocked.code).toBe(1);
      expect(blocked.out).toContain('issue: model-not-listed [blocking]');
      expect(blocked.out).not.toContain('--accept-unverified\n');
    });

    it('uses fixed messages for runner failures and never shows raw output', async () => {
      const cases: [ProcessOutcome, string, number][] = [
        [{ kind: 'completed', exitCode: 1, stdout: 'sk-secret leak', truncated: false }, 'codex run failed', 1],
        [{ kind: 'timeout' }, 'codex run timed out', 1],
        [{ kind: 'cancelled' }, 'codex run cancelled', 130],
        [{ kind: 'not-found' }, 'codex is not installed', 1],
        [{ kind: 'spawn-failed' }, 'codex could not be started', 1],
      ];
      for (const [outcome, message, code] of cases) {
        const r = await go(START, { outcome });
        expect(r.code).toBe(code);
        expect(r.error).toContain(message);
        expect(r.out).toBe('');
        expect(r.error).not.toContain('secret');
      }
    });

    it('reports truncation and rejects a missing working directory', async () => {
      const t = await go(START, { outcome: { kind: 'completed', exitCode: 0, stdout: 'x', truncated: true } });
      expect(t.error).toContain('output was truncated');
      const bad = await go([...START, '--cwd', join(tmpdir(), 'acl-does-not-exist-xyz')]);
      expect(bad.code).toBe(1);
      expect(bad.error).toContain('working directory does not exist');
      expect(bad.specs).toHaveLength(0);
    });
  });

  describe('run --provider claude', () => {
    const AUTH_PRO = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro","email":"me@example.com"}';
    const FULL_HELP = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--permission-mode <mode>', '--allowedTools <tools...>', '--disallowedTools <tools...>', '--output-format <format>', '--model <model>', '--effort <level>'].map((f) => `  ${f}  text`).join('\n');
    const claudeExec = (auth: { stdout: string; kind?: 'ok' | 'failed' | 'not-found' }, version = '2.1.312 (Claude Code)', help = FULL_HELP): Exec => (command, args) => {
      if (command !== 'claude') return Promise.resolve({ kind: 'not-found' });
      if (args[0] === '--version') return Promise.resolve({ kind: 'ok', stdout: version });
      if (args[0] === '--help') return Promise.resolve({ kind: 'ok', stdout: help });
      if (auth.kind === 'not-found') return Promise.resolve({ kind: 'not-found' });
      return Promise.resolve(
        auth.kind === 'failed' ? { kind: 'failed', detail: 'x', stdout: auth.stdout, stderr: '' } : { kind: 'ok', stdout: auth.stdout },
      );
    };
    const START = ['run', '--provider', 'claude', '--task', 'summarize this', '--confirm'];

    async function go(argv: string[], over: { exec?: Exec; outcome?: ProcessOutcome; settings?: SettingsScan; env?: Record<string, string> } = {}) {
      const specs: ProcessSpec[] = [];
      let out = '';
      let error = '';
      const dir = mkdtempSync(join(tmpdir(), 'acl-claude-run-'));
      try {
        const code = await run(
          argv,
          { out: (t) => (out += t), error: (t) => (error += t) },
          {
            exec: over.exec ?? claudeExec({ stdout: AUTH_PRO }),
            claudeSettings: () => Promise.resolve(over.settings ?? { status: 'clean' }),
            cwd: dir,
            // Explicit, so a proxy or base URL in the machine running the tests cannot change the plan.
            env: over.env ?? { PATH: '/bin' },
            runner: (spec) => {
              specs.push(spec);
              return Promise.resolve(over.outcome ?? { kind: 'completed', exitCode: 0, stdout: claudeJson('answer\n'), truncated: false });
            },
          },
        );
        return { code, out, error, specs };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('runs tool-less with a cleaned environment and prints only the answer on stdout', async () => {
      const r = await go(START);
      expect(r.code).toBe(0);
      expect(r.out).toBe('answer\n');
      expect(r.error).toContain('no tools, no session persistence, subscription login');
      expect(r.specs[0]).toMatchObject({ command: 'claude', input: 'summarize this' });
      expect(r.specs[0]?.args).toEqual(expect.arrayContaining(['-p', '--tools', '', '--strict-mcp-config', '--restricted', '--safe-mode', '--no-session-persistence']));
      expect(Object.keys(r.specs[0]?.env ?? {}).filter((k) => /^(ANTHROPIC_|CLAUDE|AWS_)/i.test(k) && k !== 'CLAUDE_CONFIG_DIR')).toEqual([]);
      expect(r.error).not.toContain('example.com');
    });

    it('refuses, naming only variable names, when proxy/TLS/base-URL variables would not be forwarded', async () => {
      const env = { PATH: '/bin', HTTPS_PROXY: 'http://user:topsecret@proxy.example:8080', NODE_EXTRA_CA_CERTS: '/ca.pem' };
      const refused = await go(START, { env });
      expect(refused.code).toBe(1);
      expect(refused.specs).toEqual([]);
      expect(refused.error).toContain('not forwarded to Claude');
      expect(refused.error).toContain('not forwarded: HTTPS_PROXY, NODE_EXTRA_CA_CERTS');
      expect(refused.error + refused.out).not.toContain('topsecret');
      expect(refused.error + refused.out).not.toContain('proxy.example');
      const accepted = await go([...START, '--accept-unverified'], { env });
      expect(accepted.code).toBe(0);
      expect(Object.keys(accepted.specs[0]?.env ?? {}).filter((k) => /PROXY|CERT|TLS/i.test(k))).toEqual([]);
    });

    it('states in the dry run that managed/MDM/server policy is not covered by the file scan', async () => {
      const r = await go(['run', '--provider', 'claude', '--task', 'x', '--dry-run']);
      expect(r.out).toContain('managed policy: file scan only');
      expect(r.out).toContain('MDM/registry and server-managed (remote) policy are not covered');
    });

    it('refuses API-key, third-party, non-Pro/Max, logged-out and missing logins', async () => {
      const cases: [Parameters<typeof claudeExec>[0], string][] = [
        [{ stdout: '{"loggedIn":true,"authMethod":"api_key"}' }, 'only a Pro/Max subscription login is allowed'],
        [{ stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock","subscriptionType":"pro"}' }, 'third-party provider'],
        [{ stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"free"}' }, 'not signed in with a verified Pro/Max subscription'],
        [{ stdout: '{"loggedIn":false}', kind: 'failed' }, 'claude is not logged in'],
        [{ stdout: '', kind: 'not-found' }, 'claude is not installed'],
        [{ stdout: 'weird' }, 'login state could not be determined'],
      ];
      for (const [auth, message] of cases) {
        const r = await go(START, { exec: claudeExec(auth) });
        expect(r.code).toBe(1);
        expect(r.error).toContain(`run refused: claude`);
        expect(r.error).toContain(message);
        expect(r.specs).toHaveLength(0);
      }
    });

    it('requires --accept-unverified for unverified choices and never lets it override blocking ones', async () => {
      for (const extra of [['--model', 'claude-opus-5-5'], ['--effort', 'high'], ['--mode', 'ultracode']]) {
        const denied = await go([...START, ...extra]);
        expect(denied.code).toBe(1);
        expect(denied.error).toContain('add --accept-unverified');
        expect(denied.specs).toHaveLength(0);
        const accepted = await go([...START, ...extra, '--accept-unverified']);
        expect(accepted.code).toBe(0);
        expect(accepted.error).toContain('warning:');
      }
      for (const extra of [['--effort', 'ultra'], ['--mode', 'ultracode', '--effort', 'high']]) {
        const blocked = await go([...START, ...extra, '--accept-unverified']);
        expect(blocked.code).toBe(1);
        expect(blocked.error).toContain('[blocking]');
        expect(blocked.specs).toHaveLength(0);
      }
    });

    it('passes ultracode as --effort ultracode, and gates it on the CLI version', async () => {
      const ok = await go([...START, '--mode', 'ultracode', '--accept-unverified']);
      expect(ok.specs[0]?.args.slice(-2)).toEqual(['--effort', 'ultracode']);
      const old = await go([...START, '--mode', 'ultracode', '--accept-unverified'], { exec: claudeExec({ stdout: AUTH_PRO }, '2.1.100 (Claude Code)') });
      expect(old.code).toBe(1);
      expect(old.error).toContain('older than the verified minimum for ultracode');
      expect(old.specs).toHaveLength(0);
    });

    it('dry-run shows the plan without starting anything or needing --confirm', async () => {
      const r = await go(['run', '--provider', 'claude', '--task', 'summarize this', '--dry-run', '--effort', 'high']);
      expect(r.code).toBe(1);
      expect(r.specs).toHaveLength(0);
      expect(r.out).toContain('run plan (dry run, no agent started)');
      expect(r.out).toContain('tools: none (built-in and MCP disabled)');
      expect(r.out).toContain('session persistence: off');
      expect(r.out).toContain('login: subscription login (pro)');
      expect(r.out).toContain('cli version: 2.1.312');
      expect(r.out).toContain('requires: --confirm, --accept-unverified');
      expect(r.out).toContain('would refuse');
      expect(r.out).not.toMatch(/summarize|example\.com/);
      const clean = await go(['run', '--provider', 'claude', '--task', 'x', '--dry-run']);
      expect(clean.code).toBe(0);
      expect(clean.out).toContain('verdict: would run');
    });

    it('refuses when the CLI does not list every safety flag, or its help cannot be read', async () => {
      const noRestricted = FULL_HELP.replace('--restricted', '--something-else');
      const missing = await go(START, { exec: claudeExec({ stdout: AUTH_PRO }, '2.1.312 (Claude Code)', noRestricted) });
      expect(missing.code).toBe(1);
      expect(missing.error).toContain('did not list every safety flag');
      expect(missing.specs).toHaveLength(0);
      const unreadable: Exec = (command, args, o) => (args[0] === '--help' ? Promise.resolve({ kind: 'timeout' }) : claudeExec({ stdout: AUTH_PRO })(command, args, o));
      const down = await go(START, { exec: unreadable });
      expect(down.code).toBe(1);
      expect(down.error).toContain('did not list every safety flag');
      // --model needs its own flag to be listed.
      const noModelFlag = FULL_HELP.replace('--model <model>', '--nope');
      expect((await go([...START, '--model', 'claude-opus-5-5', '--accept-unverified'], { exec: claudeExec({ stdout: AUTH_PRO }, '2.1.312 (Claude Code)', noModelFlag) })).code).toBe(1);
    });

    it('refuses unsafe or unverifiable settings, naming keys but never values', async () => {
      const unsafe = await go(START, {
        settings: { status: 'unsafe', findings: [{ kind: 'user', key: 'env.ANTHROPIC_BASE_URL' }, { kind: 'project', key: 'env.HTTPS_PROXY' }, { kind: 'local', key: 'apiKeyHelper' }] },
      });
      expect(unsafe.code).toBe(1);
      expect(unsafe.error).toContain('sets credentials, a provider, a proxy or a login helper');
      expect(unsafe.error).toContain('finding: user settings env.ANTHROPIC_BASE_URL');
      expect(unsafe.error).toContain('finding: project settings env.HTTPS_PROXY');
      expect(unsafe.error).toContain('finding: local settings apiKeyHelper');
      expect(unsafe.specs).toHaveLength(0);
      const broken = await go(START, { settings: { status: 'unverifiable', kind: 'project', problem: 'invalid' } });
      expect(broken.code).toBe(1);
      expect(broken.error).toContain('could not be read or parsed');
      expect(broken.error).toContain('settings: project file is invalid');
      const accepted = await go([...START, '--accept-unverified'], { settings: { status: 'unsafe', findings: [{ kind: 'user', key: 'apiKeyHelper' }] } });
      expect(accepted.code).toBe(1);
      expect(accepted.specs).toHaveLength(0);
    });

    it('rejects ultracode when the CLI version is unreadable', async () => {
      const r = await go([...START, '--mode', 'ultracode', '--accept-unverified'], { exec: claudeExec({ stdout: AUTH_PRO }, 'not a version') });
      expect(r.code).toBe(1);
      expect(r.error).toContain('version could not be read or parsed, which ultracode requires');
      expect(r.specs).toHaveLength(0);
    });

    it('names Claude (not Codex) in the missing --confirm message', async () => {
      const r = await go(START.filter((a) => a !== '--confirm'));
      expect(r.code).toBe(2);
      expect(r.error).toContain('Claude');
      expect(r.error).not.toContain('Codex');
      expect(r.error).toContain('subscription quota');
    });

    it('dry-run reports restricted mode, flag and settings checks', async () => {
      const r = await go(['run', '--provider', 'claude', '--task', 'x', '--dry-run'], { settings: { status: 'unsafe', findings: [{ kind: 'user', key: 'env.ANTHROPIC_API_KEY' }] } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('restricted: on (user, project and local settings ignored)');
      expect(r.out).toContain('flags check: ok');
      expect(r.out).toContain('settings check: unsafe');
      expect(r.out).toContain('finding: user settings env.ANTHROPIC_API_KEY');
      expect(r.out).toContain('would refuse');
    });

    it('uses fixed messages for runner failures and rejects bad options before anything runs', async () => {
      const cases: [ProcessOutcome, string, number][] = [
        [{ kind: 'completed', exitCode: 1, stdout: 'sk-leak', truncated: false }, 'claude run failed', 1],
        [{ kind: 'completed', exitCode: 0, stdout: claudeJson('<invoke name="Glob"></invoke>'), truncated: false }, 'claude answered with tool-call text only', 1],
        [{ kind: 'timeout' }, 'claude run timed out', 1],
        [{ kind: 'cancelled' }, 'claude run cancelled', 130],
        [{ kind: 'spawn-failed' }, 'claude could not be started', 1],
      ];
      for (const [outcome, message, code] of cases) {
        const r = await go(START, { outcome });
        expect(r.code).toBe(code);
        expect(r.error).toContain(message);
        expect(r.out).toBe('');
        expect(r.error).not.toContain('leak');
      }
      for (const argv of [START.filter((a) => a !== '--confirm'), [...START, '--mode', 'turbo'], [...START, '--effort', 'ultracode'], [...START, '--tools', 'Bash']]) {
        const r = await go(argv);
        expect(r.code).toBe(2);
        expect(r.specs).toHaveLength(0);
      }
    });
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

    it('blocks ultracode for Codex as a definite incompatibility', async () => {
      const r = await route(['route', '--dry-run', '--task', 'review', '--mode', 'ultracode'], 20);
      expect(r.out).toContain('recommended: codex');
      expect(r.out).toContain('issue: mode-unsupported [blocking] ultracode');
      expect(r.out).toContain('manual-approval: required');
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
