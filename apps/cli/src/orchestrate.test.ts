import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppServerProcess, EvidenceCatalog, Exec, OutcomeStore, GitState, ProcessOutcome, ProcessSpec, SettingsScan } from '@agent-control-lab/core';
import { run } from './main.ts';
import { parseOrchestrateArgs } from './orchestrate.ts';

import { asClaude } from './claude-json-fixture.ts';
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
    appServer?: () => AppServerProcess;
    store?: OutcomeStore;
    evidenceCatalog?: EvidenceCatalog;
    now?: () => Date;
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
        appServer: over.appServer ?? modelServer,
        ...(over.store === undefined ? {} : { outcomes: over.store }),
        ...(over.evidenceCatalog === undefined ? {} : { evidenceCatalog: over.evidenceCatalog }),
        ...(over.now === undefined ? {} : { now: over.now }),
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
          const outcome = over.outcomes?.[specs.length - 1] ?? done(`answer ${String(specs.length)}\n`);
          return Promise.resolve(spec.command === 'claude' ? asClaude(outcome) : outcome);
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

  it('reports the model the response named, or UNKNOWN, and never prints the raw JSON or session id', async () => {
    const known = await go(CONFIRM, { outcomes: [done('PLAN\n'), done('VERDICT\n')] });
    expect(known.out).toContain('model used (reported by the response): claude-test-1');
    expect(known.out).not.toMatch(/SESSION-SECRET|total_cost|modelUsage/);
    expect(known.error).not.toContain('SESSION-SECRET');
    const bare = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PLAN', session_id: 'SESSION-SECRET' });
    const unknown = await go(CONFIRM, { outcomes: [done(bare), done('VERDICT\n')] });
    expect(unknown.out).toContain('model used (reported by the response): UNKNOWN');
    expect(unknown.out.match(/model used/g)).toHaveLength(1);
    expect(unknown.out).not.toContain('SESSION-SECRET');
  });

  it('fails the step, with a fixed reason, when the plan is only tool-call text', async () => {
    const call = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '<invoke name="Glob"></invoke>', modelUsage: { 'claude-sonnet-5-5': {} } });
    const r = await go(CONFIRM, { outcomes: [done(call)] });
    expect(r.code).toBe(1);
    expect(r.specs.map((s) => s.command)).toEqual(['claude']);
    expect(r.out).toMatch(/plan\s+claude\s+failed/);
    expect(r.out).toContain('tool-call text only');
    expect(r.out).not.toContain('<invoke');
    expect(r.out).not.toContain('model used');
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

describe('orchestrate --model-routing', () => {
  const twoModels = (): AppServerProcess => {
    let lineCb: (line: string) => void = () => undefined;
    return {
      send: (line) => {
        const m = JSON.parse(line) as { id?: number; method: string };
        if (m.id === undefined) return;
        const eff = (...l: string[]) => l.map((reasoningEffort) => ({ reasoningEffort }));
        const reply = m.method === 'model/list'
          ? { result: { data: [{ model: 'gpt-a', supportedReasoningEfforts: eff('low', 'medium') }, { model: 'gpt-b', supportedReasoningEfforts: eff('low', 'medium', 'high') }], nextCursor: null } }
          : { result: {} };
        queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    };
  };
  const risky = ['orchestrate', '--workflow', 'plan-review', '--task', 'fix the auth flag', '--policy', 'quality'];

  it('defaults to auto and rejects unknown values', () => {
    const base = ['--workflow', 'plan-review', '--task', 'x', '--dry-run'];
    expect(parseOrchestrateArgs(base)).toMatchObject({ modelRouting: 'auto' });
    expect(parseOrchestrateArgs([...base, '--model-routing', 'adaptive'])).toMatchObject({ modelRouting: 'adaptive' });
    for (const bad of [['--model-routing'], ['--model-routing', 'smart'], ['--model-routing', 'ultracode']]) {
      expect(typeof parseOrchestrateArgs([...base, ...bad])).toBe('string');
    }
  });

  it('changes nothing without the option, even with a catalog that would allow a choice', async () => {
    const r = await go([...risky, '--confirm'], { appServer: twoModels });
    expect(r.specs[1]?.args).not.toContain('-m');
    const dry = await go([...risky, '--dry-run'], { appServer: twoModels });
    expect(dry.out).not.toContain('model routing');
    expect(dry.out).not.toContain('adaptive routing');
  });

  it('pins the only Codex model that supports the target effort, shows the evidence and starts it', async () => {
    const dry = await go([...risky, '--dry-run', '--model-routing', 'adaptive'], { appServer: twoModels });
    expect(dry.out).toContain('model routing: adaptive');
    expect(dry.out).toContain('model: gpt-b (verified); reason: adaptive routing: gpt-b: the only listed model that supports high');
    expect(dry.out).toContain('evidence: models supporting high: gpt-b');
    expect(dry.out).toContain('evidence: target effort: high (quality base high');
    expect(dry.out).toContain('effort: high (verified); reason: policy quality: high');
    expect(dry.out).toContain('verdict: would run');
    const live = await go([...risky, '--confirm', '--model-routing', 'adaptive'], { appServer: twoModels });
    expect(live.specs[1]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-b', '-c', 'model_reasoning_effort=high']));
    expect(live.specs[0]?.args).not.toContain('--model');
  });

  it('keeps the Claude default with UNKNOWN access, and the Codex default when nothing is distinguishable', async () => {
    const dry = await go([...risky.slice(0, 4), 'rename a variable', '--dry-run', '--model-routing', 'adaptive'], { appServer: twoModels });
    expect(dry.out).toContain('adaptive routing: provider default kept: a Claude model cannot be shown to be accessible');
    expect(dry.out).toContain('claude access: UNKNOWN');
    expect(dry.out).toMatch(/adaptive routing: provider default kept: .*(supports|no listed model)/);
    const one = await go([...risky, '--dry-run', '--model-routing', 'adaptive']);
    expect(one.out).toContain('the list offers no alternative to choose between');
  });

  it('lets manual choices win and never selects ultracode', async () => {
    const manual = await go([...risky, '--dry-run', '--model-routing', 'adaptive', '--step-model', 'review=gpt-a', '--step-effort', 'plan=low'], { appServer: twoModels });
    expect(manual.out).toContain('reason: requested with --step-model review=gpt-a');
    expect(manual.out).toContain('adaptive routing: not applied: the effort was set manually');
    expect(manual.out).toContain('model: gpt-a');
    expect(manual.out).not.toMatch(/model: gpt-b/);
    const live = await go([...risky, '--confirm', '--model-routing', 'adaptive'], { appServer: twoModels });
    for (const spec of live.specs) expect(spec.args.join(' ')).not.toContain('ultracode');
  });
});

describe('orchestrate --model-routing measured / --no-record', () => {
  it('parses both and defaults to recording', () => {
    const base = ['--workflow', 'plan-review', '--task', 'x', '--dry-run'];
    expect(parseOrchestrateArgs(base)).toMatchObject({ record: true, modelRouting: 'auto' });
    expect(parseOrchestrateArgs([...base, '--model-routing', 'measured', '--no-record'])).toMatchObject({ record: false, modelRouting: 'measured' });
  });

  it('keeps defaults for measured when there is no data, and records only when a store is given', async () => {
    const dry = await go([...DRY, '--model-routing', 'measured']);
    expect(dry.out).toContain('model routing: measured');
    expect(dry.out).toContain('provider default kept: not enough comparable data');
    const saved: unknown[] = [];
    const store = { load: () => Promise.resolve([]), append: (r: readonly unknown[]) => { saved.push(...r); return Promise.resolve(); }, clear: () => Promise.resolve() };
    const live = await go([...CONFIRM], { store });
    expect(live.code).toBe(0);
    expect(saved).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain('--json');
    expect(live.error).toContain('2 step result(s) recorded locally');
    const none = await go([...CONFIRM]);
    expect(none.error).not.toContain('outcomes:');
  });
});

describe('orchestrate --model-routing research', () => {
  const server = (...ids: string[]) => (): AppServerProcess => {
    let lineCb: (line: string) => void = () => undefined;
    return {
      send: (line) => {
        const m = JSON.parse(line) as { id?: number; method: string };
        if (m.id === undefined) return;
        const eff = ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort }));
        const reply = m.method === 'model/list' ? { result: { data: ids.map((model) => ({ model, supportedReasoningEfforts: eff })), nextCursor: null } } : { result: {} };
        queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    };
  };
  const both = server('gpt-6.1-sol', 'gpt-6.1-terra');
  const hard = ['orchestrate', '--workflow', 'plan-review', '--task', 'fix the auth token handling', '--model-routing', 'research'];
  // A catalog with a code-review comparison measured at medium, the effort a small sensitive task runs at under `balanced`.
  const catalog: EvidenceCatalog = {
    version: 'test.1',
    sources: [{ id: 'ind', url: 'https://example.test/review-bench', publisher: 'Example Lab', kind: 'independent', published: '2026-10-20', retrieved: '2026-10-30' }],
    entries: ['gpt-6.1-sol:72', 'gpt-6.1-terra:60'].map((x) => ({
      sourceId: 'ind', group: 'g', provider: 'codex' as const, model: x.split(':')[0] ?? '', variant: 'V', benchmark: 'ReviewBench', benchmarkVersion: '1', fit: 'code-review' as const,
      metric: 'percent' as const, score: Number(x.split(':')[1]), effort: 'medium', harness: 'example harness', confidence: 'high' as const,
    })),
    claims: [],
  };
  const NOW = () => new Date('2026-11-02T00:00:00Z');

  it('parses the option', () => {
    expect(parseOrchestrateArgs(['--workflow', 'plan-review', '--task', 'x', '--dry-run', '--model-routing', 'research'])).toMatchObject({ modelRouting: 'research' });
  });

  it('keeps the provider default with the shipped catalog, because nothing task-fit and equivalent exists, and says why', async () => {
    const dry = await go([...hard, '--dry-run'], { appServer: both });
    expect(dry.out).toContain('model routing: research');
    expect(dry.out).toContain('adaptive routing: provider default kept: no comparable evidence of the right kind');
    expect(dry.out).toContain('context only, not evidence for review work: Artificial Analysis Intelligence Index v5.0 (general-intelligence): gpt-6.1-sol 55 points, gpt-6.1-terra 51 points');
    expect(dry.out).toContain('re-reading a page does not refresh a benchmark');
    expect(dry.out).toContain('verdict: would run');
    const live = await go([...hard, '--confirm'], { appServer: both });
    for (const spec of live.specs) {
      expect(spec.args).not.toContain('--model');
      expect(spec.args).not.toContain('-m');
    }
  });

  it('shows the OpenAI pages\' stated results for a coding step and why they are not used', async () => {
    const write = await go(['orchestrate', '--workflow', 'plan-review', '--task', 'fix the auth token handling', '--model-routing', 'research', '--dry-run'], { appServer: both });
    expect(write.out).not.toContain('model: gpt-6.1');
  });

  it('pins a Codex model, with the evidence effort, when an injected catalog gives task-fit evidence at the effort the step runs at', async () => {
    const dry = await go([...hard, '--dry-run'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(dry.out).toContain('model: gpt-6.1-sol (verified); reason: adaptive routing: gpt-6.1-sol: leads comparable published results');
    expect(dry.out).toContain('effort: medium (verified); reason: policy balanced: the effort equals the effort the published evidence was measured at');
    expect(dry.out).toContain('source https://example.test/review-bench (evaluation date not stated by the source, published 2026-10-20, page read 2026-10-30');
    expect(dry.out).toContain('evidence catalog test.1');
    const live = await go([...hard, '--confirm'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(live.specs[1]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium']));
  });

  it('does not pin when the provider no longer lists the model or the effort, nor a Claude model', async () => {
    const unlisted = await go([...hard, '--dry-run'], { appServer: server('gpt-6.1-sol'), evidenceCatalog: catalog, now: NOW });
    expect(unlisted.out).not.toContain('model: gpt-6.1-sol');
    const live = await go([...hard, '--confirm'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(live.specs[0]?.args).not.toContain('--model');
  });

  it('keeps the default for easy tasks, and manual choices win', async () => {
    const easy = await go([...hard.slice(0, 4), 'rename a variable', ...hard.slice(5), '--dry-run'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(easy.out).toContain('an easy task does not call for a model chosen by benchmark leads');
    const manual = await go([...hard, '--dry-run', '--step-model', 'review=gpt-6.1-terra'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(manual.out).toContain('reason: requested with --step-model review=gpt-6.1-terra');
    const effort = await go([...hard, '--dry-run', '--step-effort', 'review=high'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    expect(effort.out).toContain('not applied: the effort was set manually');
    const live = await go([...hard, '--confirm'], { appServer: both, evidenceCatalog: catalog, now: NOW });
    for (const spec of live.specs) expect(spec.args.join(' ')).not.toContain('ultracode');
  });

  it('adds no research output without the option', async () => {
    const plain = await go(hard.slice(0, 4).concat(['--dry-run']), { appServer: both });
    expect(plain.out).not.toContain('evidence catalog');
  });
});

describe('orchestrate --model-routing guided', () => {
  const server = (...ids: string[]) => (): AppServerProcess => {
    let lineCb: (line: string) => void = () => undefined;
    return {
      send: (line) => {
        const m = JSON.parse(line) as { id?: number; method: string };
        if (m.id === undefined) return;
        const eff = ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort }));
        const reply = m.method === 'model/list' ? { result: { data: ids.map((model) => ({ model, supportedReasoningEfforts: eff })), nextCursor: null } } : { result: {} };
        queueMicrotask(() => { lineCb(JSON.stringify({ id: m.id, ...reply })); });
      },
      onLine: (cb) => (lineCb = cb),
      onExit: () => undefined,
      kill: () => Promise.resolve(),
    };
  };
  const all = server('gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna');
  const base = (task: string, ...extra: string[]) => ['orchestrate', '--workflow', 'plan-review', '--task', task, '--model-routing', 'guided', ...extra];
  const HARD = 'fix the auth token handling';
  const EASY = 'rename a variable';
  const reviewModel = (out: string) => /\[codex\]: [^\n]*\n\s+model: ([^ ;]+)/.exec(out)?.[1];
  const catalog: EvidenceCatalog = {
    version: 'test.1',
    sources: [{ id: 'ind', url: 'https://example.test/review-bench', publisher: 'Example Lab', kind: 'independent', published: '2026-10-20', retrieved: '2026-10-30' }],
    entries: ['gpt-6.1-sol:72', 'gpt-6.1-terra:60'].map((x) => ({
      sourceId: 'ind', group: 'g', provider: 'codex' as const, model: x.split(':')[0] ?? '', variant: 'V', benchmark: 'ReviewBench', benchmarkVersion: '1', fit: 'code-review' as const,
      metric: 'percent' as const, score: Number(x.split(':')[1]), effort: 'medium', harness: 'example harness', confidence: 'high' as const,
    })),
    claims: [],
  };
  const NOW = () => new Date('2026-11-02T00:00:00Z');

  it('parses the option', () => {
    expect(parseOrchestrateArgs(['--workflow', 'plan-review', '--task', 'x', '--dry-run', '--model-routing', 'guided'])).toMatchObject({ modelRouting: 'guided' });
  });

  it('chooses from documented purposes and the Codex list by policy, shows basis and uncertainty, and keeps benchmark evidence separate', async () => {
    const quality = await go([...base(HARD, '--policy', 'quality'), '--dry-run'], { appServer: all });
    expect(quality.out).toContain('model routing: guided');
    expect(quality.out).toContain('model: gpt-6-astra (verified); reason: guided routing: gpt-6-astra: documented for complex-work');
    expect(quality.out).toContain('routing basis: documented intent of the model (vendor documentation), not a measurement; uncertainty: medium');
    expect(quality.out).toContain('evidence: benchmark evidence (strict, the same rules as --model-routing research): provider default kept');
    expect(quality.out).toContain('evidence: intent-based reading (vendor documentation, not measurements)');
    expect(quality.out).toContain('https://developers.openai.com/api/docs/guides/latest-model, read 2026-10-31');
    const economy = await go([...base(HARD, '--policy', 'economy'), '--dry-run'], { appServer: all });
    expect(economy.out).toContain('model: gpt-6.1-sol (verified)');
    const balanced = await go([...base(HARD), '--dry-run'], { appServer: all });
    expect(balanced.out).toContain('model: gpt-6.1-sol (verified)');
    expect(balanced.out).toContain('verdict: would run');
  });

  it('uses the documented small model for an easy task, not under quality, and starts the chosen Codex model', async () => {
    const easy = await go([...base(EASY), '--dry-run'], { appServer: all });
    expect(easy.out).toContain('model: gpt-6-luna (verified)');
    const quality = await go([...base(EASY, '--policy', 'quality'), '--dry-run'], { appServer: all });
    expect(quality.out).toContain('model: gpt-6-astra (verified)');
    const live = await go([...base(HARD), '--confirm'], { appServer: all });
    expect(live.specs[1]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol']));
    expect(live.specs[1]?.args.join(' ')).toContain('model_reasoning_effort=');
  });

  it('never pins a Claude model, with access marked UNKNOWN', async () => {
    const dry = await go([...base(HARD), '--dry-run'], { appServer: all });
    expect(dry.out).toContain('claude access: UNKNOWN');
    expect(dry.out).toContain('documentation does not settle which of claude-fable-5-1, claude-opus-5-5');
    expect(dry.out).toContain('routing basis: no sufficient basis, provider default; uncertainty: high');
    const live = await go([...base(HARD), '--confirm'], { appServer: all });
    expect(live.specs[0]?.args).not.toContain('--model');
    for (const spec of live.specs) expect(spec.args.join(' ')).not.toContain('ultracode');
  });

  it('keeps the provider default when no listed model is documented for the work', async () => {
    const terra = await go([...base(HARD), '--dry-run'], { appServer: server('gpt-6.1-terra') });
    expect(terra.out).toContain('guided routing: provider default kept: no available model is documented for complex-work');
    expect(terra.out).not.toContain('model: gpt-6.1-terra');
    const unknown = await go([...base(HARD), '--dry-run'], { appServer: server('gpt-9-new') });
    expect(unknown.out).toContain('gpt-9-new: no documented purpose');
    expect(unknown.out).not.toContain('model: gpt-9-new');
  });

  it('prefers strict benchmark evidence when it exists, shows the documented intent next to it, and reports low uncertainty', async () => {
    const dry = await go([...base(HARD), '--dry-run'], { appServer: all, evidenceCatalog: catalog, now: NOW });
    expect(dry.out).toContain('model: gpt-6.1-sol (verified); reason: guided routing: gpt-6.1-sol: gpt-6.1-sol: leads comparable published results');
    expect(dry.out).toContain('routing basis: measured benchmark evidence; uncertainty: low');
    expect(dry.out).toContain('intent-based reading (shown separately, vendor documentation): the documented intent agrees');
    const astraLeads: EvidenceCatalog = { ...catalog, entries: catalog.entries.map((e) => (e.model === 'gpt-6.1-sol' ? { ...e, model: 'gpt-6-astra' } : { ...e, model: 'gpt-6.1-sol' })) };
    const disagree = await go([...base(HARD), '--dry-run'], { appServer: all, evidenceCatalog: astraLeads, now: NOW });
    expect(disagree.out).toContain('model: gpt-6-astra (verified)');
    expect(disagree.out).toContain('the documented intent points to gpt-6.1-sol instead; the measured evidence is used');
    const higher = await go([...base(HARD, '--policy', 'quality'), '--dry-run'], { appServer: all, evidenceCatalog: catalog, now: NOW });
    expect(higher.out).toContain('results at different efforts are not equivalent');
    expect(higher.out).not.toContain('routing basis: measured benchmark evidence');
  });

  it('keeps manual choices and leaves research and the other modes unchanged', async () => {
    const manual = await go([...base(HARD), '--dry-run', '--step-model', 'review=gpt-6.1-terra'], { appServer: all });
    expect(manual.out).toContain('reason: requested with --step-model review=gpt-6.1-terra');
    expect(manual.out).not.toContain('model: gpt-6-astra');
    const effort = await go([...base(HARD), '--dry-run', '--step-effort', 'review=high'], { appServer: all });
    expect(effort.out).toContain('not applied: the effort was set manually');
    const research = await go(['orchestrate', '--workflow', 'plan-review', '--task', HARD, '--model-routing', 'research', '--dry-run'], { appServer: all });
    expect(research.out).not.toContain('intent-based reading');
    expect(research.out).not.toContain('routing basis');
    const plain = await go(['orchestrate', '--workflow', 'plan-review', '--task', HARD, '--dry-run'], { appServer: all });
    expect(plain.out).not.toContain('intent-based');
    expect(reviewModel(plain.out)).toBeDefined();
  });
});
