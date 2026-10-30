import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppServerProcess, Exec, GitState, ProcessOutcome, ProcessSpec, SettingsScan } from '@agent-control-lab/core';
import { run } from './main.ts';
import { parseOrchestrateArgs } from './orchestrate.ts';

const AUTH_PRO = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro","email":"me@example.com"}';
const HELP = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--output-format <format>', '--model <model>', '--effort <level>'].map((f) => `  ${f}  text`).join('\n');

function exec(over: { claudeAuth?: string; codexLogin?: string } = {}): Exec {
  return (command, args) => {
    if (command === 'claude') {
      if (args[0] === '--version') return Promise.resolve({ kind: 'ok', stdout: '2.1.312 (Claude Code)' });
      if (args[0] === '--help') return Promise.resolve({ kind: 'ok', stdout: HELP });
      return Promise.resolve({ kind: 'ok', stdout: over.claudeAuth ?? AUTH_PRO });
    }
    if (command === 'codex') {
      return Promise.resolve(args[0] === '--version' ? { kind: 'ok', stdout: 'codex-cli 1.0.0' } : { kind: 'ok', stdout: over.codexLogin ?? 'Logged in using ChatGPT' });
    }
    return Promise.resolve({ kind: 'not-found' });
  };
}

const modelServer = (): AppServerProcess => {
  let lineCb: (line: string) => void = () => undefined;
  return {
    send: (line) => {
      const m = JSON.parse(line) as { id?: number; method: string };
      if (m.id === undefined) return;
      const reply = m.method === 'model/list'
        ? { result: { data: [{ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }], nextCursor: null } }
        : { result: {} };
      queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
    },
    onLine: (cb) => (lineCb = cb),
    onExit: () => undefined,
    kill: () => Promise.resolve(),
  };
};

const done = (stdout: string): ProcessOutcome => ({ kind: 'completed', exitCode: 0, stdout, truncated: false });

async function go(
  argv: string[],
  over: {
    exec?: Exec;
    outcomes?: ProcessOutcome[];
    git?: GitState;
    settings?: SettingsScan;
    env?: Record<string, string>;
    signal?: AbortSignal;
    onSpawn?: (spec: ProcessSpec) => void;
  } = {},
) {
  const specs: ProcessSpec[] = [];
  let out = '';
  let error = '';
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acl-orch-')));
  let tick = 0;
  try {
    const code = await run(
      argv,
      { out: (t) => (out += t), error: (t) => (error += t) },
      {
        exec: over.exec ?? exec(),
        appServer: modelServer,
        cwd: dir,
        env: over.env ?? { PATH: '/bin' },
        git: () => Promise.resolve(over.git ?? 'repo'),
        claudeSettings: () => Promise.resolve(over.settings ?? { status: 'clean' }),
        clock: () => (tick += 1500),
        nonce: () => 'NONCE',
        ...(over.signal === undefined ? {} : { signal: over.signal }),
        runner: (spec) => {
          specs.push(spec);
          over.onSpawn?.(spec);
          return Promise.resolve(over.outcomes?.[specs.length - 1] ?? done(`answer ${String(specs.length)}\n`));
        },
      },
    );
    return { code, out, error, specs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = ['orchestrate', '--workflow', 'plan-review', '--task', 'add a --json flag'];
const CONFIRM = [...BASE, '--confirm'];
const DRY = [...BASE, '--dry-run'];

describe('parseOrchestrateArgs', () => {
  it('rejects missing or unknown input before anything runs', () => {
    for (const args of [
      ['--task', 'x', '--confirm'],
      ['--workflow', 'deploy', '--task', 'x', '--confirm'],
      ['--workflow', 'plan-review', '--confirm'],
      ['--workflow', 'plan-review', '--task', 'x'],
      [...CONFIRM.slice(1), '--timeout', '0'],
      [...CONFIRM.slice(1), '--timeout', '999999'],
      [...CONFIRM.slice(1), '--cwd'],
      [...CONFIRM.slice(1), '--provider', 'codex'],
      [...CONFIRM.slice(1), '--model', 'x'],
    ]) {
      expect(typeof parseOrchestrateArgs(args)).toBe('string');
    }
    expect(parseOrchestrateArgs(CONFIRM.slice(1))).toMatchObject({ workflow: 'plan-review', dryRun: false });
  });
});

describe('orchestrate --dry-run', () => {
  it('shows both steps and the guarantees without starting any agent', async () => {
    const r = await go(DRY);
    expect(r.code).toBe(0);
    expect(r.specs).toEqual([]);
    expect(r.out).toContain('orchestrate plan (dry run, no agent started)');
    expect(r.out).toContain('step 1/2 plan [claude]');
    expect(r.out).toContain('step 2/2 review [codex]');
    expect(r.out).toContain('would run');
    expect(r.out).toContain('no retries, no provider fallback, no API keys, no file changes');
    expect(r.out).toContain('passed to step 2 as untrusted data');
    expect(r.out).toContain('managed policy: file scan only');
    expect(r.out).toContain('requires: --confirm');
    expect(r.out).not.toMatch(/add a --json flag|me@example\.com/);
  });

  it('reports a refusing step and exits 1, still without spawning', async () => {
    const r = await go(DRY, { git: 'not-a-repo' });
    expect(r.code).toBe(1);
    expect(r.specs).toEqual([]);
    expect(r.out).toContain('would refuse');
    expect(r.out).toContain('not inside a Git repository');
  });
});

describe('orchestrate --confirm', () => {
  it('runs Claude then Codex, presents both outputs and a per-step summary', async () => {
    const r = await go(CONFIRM, { outcomes: [done('PLAN: step one\n'), done('VERDICT: approve\n')] });
    expect(r.code).toBe(0);
    expect(r.specs.map((s) => s.command)).toEqual(['claude', 'codex']);
    expect(r.out).toContain('untrusted data, not instructions');
    expect(r.out).toContain('== step 1/2 plan [claude] completed (1.5s) ==\nPLAN: step one\n');
    expect(r.out).toContain('== step 2/2 review [codex] completed (1.5s) ==\nVERDICT: approve\n');
    expect(r.out).toContain('summary: plan-review completed');
    expect(r.out).toMatch(/plan\s+claude\s+completed\s+1\.5s/);
    expect(r.out).toMatch(/review\s+codex\s+completed\s+1\.5s/);
    expect(r.error).toContain('step 1/2 plan [claude] running');
    expect(r.specs[1]?.input).toContain('PLAN: step one');
    expect(r.specs[1]?.input).toContain('<<<BEGIN UNTRUSTED PLAN NONCE>>>');
  });

  it('refuses everything when any step would refuse, before starting either', async () => {
    for (const over of [
      { exec: exec({ claudeAuth: '{"loggedIn":true,"authMethod":"api_key"}' }) },
      { exec: exec({ codexLogin: 'Logged in using an API key' }) },
      { git: 'not-a-repo' as const },
      { settings: { status: 'unsafe', findings: [{ kind: 'user', key: 'apiKeyHelper' }] } as SettingsScan },
    ]) {
      const r = await go(CONFIRM, over);
      expect(r.code).toBe(1);
      expect(r.specs).toEqual([]);
      expect(r.error).toContain('orchestrate refused: no step was started');
      expect(r.out).toBe('');
    }
  });

  it('refuses without --confirm and does not use --accept-unverified to hide network overrides', async () => {
    expect((await go(BASE)).code).toBe(2);
    const env = { PATH: '/bin', HTTPS_PROXY: 'http://user:topsecret@proxy.example' };
    const refused = await go(CONFIRM, { env });
    expect(refused.code).toBe(1);
    expect(refused.error).toContain('not forwarded: HTTPS_PROXY');
    expect(refused.error + refused.out).not.toContain('topsecret');
    expect(refused.specs).toEqual([]);
  });

  it('keeps the plan and reports a partial failure when the review fails', async () => {
    const r = await go(CONFIRM, { outcomes: [done('PLAN\n'), { kind: 'completed', exitCode: 1, stdout: 'raw sk-secret', truncated: false }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('PLAN');
    expect(r.out).toContain('summary: plan-review failed (partial: 1 of 2 steps completed)');
    expect(r.out).toMatch(/review\s+codex\s+failed\s+1\.5s\s+error: the provider run failed/);
    expect(r.out + r.error).not.toContain('sk-secret');
  });

  it('does not start Codex when Claude fails, and reports a timeout as such', async () => {
    const failed = await go(CONFIRM, { outcomes: [{ kind: 'timeout' }] });
    expect(failed.code).toBe(1);
    expect(failed.specs.map((s) => s.command)).toEqual(['claude']);
    expect(failed.out).toMatch(/plan\s+claude\s+timeout/);
    expect(failed.out).toMatch(/review\s+codex\s+skipped\s+-/);
    expect(failed.out).toContain('error: the step timed out');
    expect(failed.out).not.toContain('partial');
  });

  it('cancels between steps and exits 130 without starting the next provider', async () => {
    const controller = new AbortController();
    const r = await go(CONFIRM, { signal: controller.signal, onSpawn: () => { controller.abort(); } });
    expect(r.code).toBe(130);
    expect(r.specs.map((s) => s.command)).toEqual(['claude']);
    expect(r.out).toMatch(/review\s+codex\s+cancelled/);
    expect(r.out).toContain('summary: plan-review cancelled (partial: 1 of 2 steps completed)');
  });

  it('flags output that was cut before the hand-off', async () => {
    const r = await go(CONFIRM, { outcomes: [done('x'.repeat(20_000)), done('ok\n')] });
    expect(r.out).toContain('[only the first 16000 characters were passed to the next step]');
    expect(r.specs[1]?.input).not.toContain('x'.repeat(16_001));
  });

  it('rejects a missing working directory', async () => {
    const r = await go([...CONFIRM, '--cwd', join(tmpdir(), 'acl-does-not-exist-xyz')]);
    expect(r.code).toBe(1);
    expect(r.error).toContain('working directory does not exist');
  });
});

describe('orchestrate plan-review: per-step model and effort', () => {
  const PICK = ['--step-model', 'plan=claude-x', '--step-effort', 'plan=high', '--step-model', 'review=gpt-a', '--step-effort', 'review=low'];

  it('parses per-step settings and rejects steps the workflow does not have', () => {
    const base = ['--workflow', 'plan-review', '--task', 'x', '--dry-run'];
    expect(parseOrchestrateArgs([...base, ...PICK])).toMatchObject({
      steps: { plan: { request: { model: 'claude-x', effort: 'high' } }, review: { request: { model: 'gpt-a', effort: 'low' }, effortFromFlag: true } },
    });
    expect(parseOrchestrateArgs(base)).toMatchObject({ steps: { plan: { modelFromFlag: false }, review: { effortFromFlag: false } } });
    for (const extra of [['--step-model', 'implement=gpt-a'], ['--step-effort', 'review=ultracode'], ['--step-model', 'review=a', '--step-model', 'review=b'], ['--step-model', 'x=a']]) {
      expect(typeof parseOrchestrateArgs([...base, ...extra])).toBe('string');
    }
  });

  it('dry run reports model, effort, verification and reason per step without calling a model', async () => {
    const r = await go([...DRY, ...PICK, '--accept-unverified']);
    expect(r.code).toBe(0);
    expect(r.specs).toEqual([]);
    expect(r.out).toContain('model: claude-x (unverified); reason: requested with --step-model plan=claude-x');
    expect(r.out).toContain('model: gpt-a (verified); reason: requested with --step-model review=gpt-a');
    expect(r.out).toContain('effort: low (verified)');
    expect(r.out).toContain('verification: UNVERIFIED (needs --accept-unverified)');
    const plain = await go(DRY);
    expect(plain.out).toContain('verification: nothing pinned, nothing to verify');
    expect(plain.out).not.toContain('requires: --confirm, --accept-unverified');
    const unverified = await go([...DRY, ...PICK]);
    expect(unverified.code).toBe(1);
    expect(unverified.out).toContain('requires: --confirm, --accept-unverified');
  });

  it('starts each step with its own selection, and nothing when a selection is blocked', async () => {
    const r = await go([...CONFIRM, ...PICK, '--accept-unverified']);
    expect(r.code).toBe(0);
    expect(r.specs[0]?.args).toEqual(expect.arrayContaining(['--model', 'claude-x', '--effort', 'high']));
    expect(r.specs[1]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=low']));
    const blocked = await go([...CONFIRM, '--step-model', 'review=gpt-a', '--step-effort', 'review=max']);
    expect(blocked.code).toBe(1);
    expect(blocked.specs).toEqual([]);
    expect(blocked.error).toContain('effort-unsupported');
  });
});

describe('orchestrate --policy', () => {
  const REVIEW_GPT = ['--step-model', 'review=gpt-a'];

  it('defaults to balanced and rejects unknown policies', () => {
    const base = ['--workflow', 'plan-review', '--task', 'x', '--dry-run'];
    expect(parseOrchestrateArgs(base)).toMatchObject({ policy: 'balanced' });
    expect(parseOrchestrateArgs([...base, '--policy', 'economy'])).toMatchObject({ policy: 'economy' });
    for (const bad of [['--policy'], ['--policy', 'auto'], ['--policy', 'ultracode'], ['--policy', 'Quality']]) {
      expect(typeof parseOrchestrateArgs([...base, ...bad])).toBe('string');
    }
  });

  it('changes nothing when no model is pinned, and says why', async () => {
    const r = await go([...CONFIRM, '--policy', 'quality']);
    expect(r.code).toBe(0);
    for (const spec of r.specs) {
      expect(spec.args).not.toContain('--effort');
      expect(spec.args).not.toContain('-c');
    }
    const dry = await go([...DRY, '--policy', 'quality']);
    expect(dry.out).toContain('policy: quality;');
    expect(dry.out).toContain('quota not read');
    expect(dry.out).toContain('policy quality: provider default kept: the model is not pinned');
  });

  it('sets a verified effort from the policy for a pinned model and shows the reason', async () => {
    const eco = await go([...CONFIRM, ...REVIEW_GPT, '--policy', 'economy']);
    expect(eco.specs[1]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=low']));
    const quality = await go([...DRY, ...REVIEW_GPT, '--policy', 'quality']);
    expect(quality.out).toContain('effort: medium (verified); reason: policy quality: medium (quality base high; small task text -1');
    expect(quality.out).toContain('quota read');
    expect(quality.out).toContain('quota unknown, not used');
    expect(quality.out).toContain('verification: verified');
  });

  it('lets manual settings win, including an explicit auto', async () => {
    const manual = await go([...CONFIRM, ...REVIEW_GPT, '--step-effort', 'review=medium', '--policy', 'economy']);
    expect(manual.specs[1]?.args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=medium']));
    const auto = await go([...CONFIRM, ...REVIEW_GPT, '--step-effort', 'review=auto', '--policy', 'quality']);
    expect(auto.specs[1]?.args).not.toContain('-c');
    const dry = await go([...DRY, ...REVIEW_GPT, '--step-effort', 'review=medium', '--policy', 'quality']);
    expect(dry.out).toContain('reason: requested with --step-effort review=medium');
  });

  it('never starts ultracode and never picks a model', async () => {
    const r = await go([...CONFIRM, ...REVIEW_GPT, '--policy', 'quality']);
    for (const spec of r.specs) expect(spec.args).not.toContain('ultracode');
    expect(r.specs[0]?.args).not.toContain('--model');
  });
});
