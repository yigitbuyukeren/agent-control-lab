import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess, type AppServerProcess, type Exec, type OutcomeRecord, type OutcomeStore, type ProcessOutcome, type ProcessSpec } from '@agent-control-lab/core';
import { run } from './main.ts';
import { parseOrchestrateArgs } from './orchestrate.ts';

const AUTH_PRO = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro","email":"me@example.com"}';
import { asClaude } from './claude-json-fixture.ts';
import { OutcomeStoreLockedError } from './outcome-store.ts';
const HELP = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--output-format <format>', '--model <model>', '--effort <level>'].map((f) => `  ${f}  text`).join('\n');

const exec: Exec = (command, args) => {
  if (command === 'claude') {
    if (args[0] === '--version') return Promise.resolve({ kind: 'ok', stdout: '2.1.312 (Claude Code)' });
    if (args[0] === '--help') return Promise.resolve({ kind: 'ok', stdout: HELP });
    return Promise.resolve({ kind: 'ok', stdout: AUTH_PRO });
  }
  if (command === 'codex') return Promise.resolve({ kind: 'ok', stdout: args[0] === '--version' ? 'codex-cli 1.0.0' : 'Logged in using ChatGPT' });
  return Promise.resolve({ kind: 'not-found' });
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const done = (stdout: string): ProcessOutcome => ({ kind: 'completed', exitCode: 0, stdout, truncated: false });
// The machine's own proxy/base URL/Git overrides must not change the scenario.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(ANTHROPIC_|CLAUDE_CODE_USE_|NODE_EXTRA_CA|NODE_TLS|SSL_CERT|GIT_)|_PROXY$/i.test(k)),
) as Record<string, string>;

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

let root = '';
let main = '';
let wt = '';

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl wr ')));
  main = join(root, 'main');
  wt = join(root, 'wt');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'one\ntwo\n');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Scenario {
  /** Called when a model or tool process would start; may edit the workspace to imitate the agent. */
  onCodex?: (spec: ProcessSpec) => ProcessOutcome | undefined;
  onVerify?: (spec: ProcessSpec) => ProcessOutcome | undefined;
  claude?: ProcessOutcome[];
  signal?: AbortSignal;
  outcomes?: OutcomeStore;
}

async function go(argv: string[], scenario: Scenario = {}) {
  const specs: ProcessSpec[] = [];
  let out = '';
  let error = '';
  let claudeCalls = 0;
  const code = await run(
    argv,
    { out: (t) => (out += t), error: (t) => (error += t) },
    {
      exec,
      appServer: modelServer,
      env: CLEAN_ENV,
      git: () => Promise.resolve('repo'),
      claudeSettings: () => Promise.resolve({ status: 'clean' }),
      clock: (() => { let t = 0; return () => (t += 1000); })(),
      nonce: () => 'NONCE',
      now: () => new Date('2026-10-30T12:00:00Z'),
      ...(scenario.outcomes === undefined ? {} : { outcomes: scenario.outcomes }),
      ...(scenario.signal === undefined ? {} : { signal: scenario.signal }),
      runner: (spec) => {
        if (spec.command === 'git') return runProcess(spec);
        specs.push(spec);
        if (spec.command === 'claude') {
          claudeCalls += 1;
          return Promise.resolve(asClaude(scenario.claude?.[claudeCalls - 1] ?? done(claudeCalls === 1 ? 'PLAN: change a.txt' : 'VERDICT: approve')));
        }
        if (spec.command === 'codex') return Promise.resolve(scenario.onCodex?.(spec) ?? done('implemented'));
        return Promise.resolve(scenario.onVerify?.(spec) ?? done('ok\n'));
      },
    },
  );
  return { code, out, error, specs, commands: specs.map((s) => s.command) };
}

const ARGS = () => ['orchestrate', '--workflow', 'plan-implement-review', '--task', 'add a --json flag', '--workspace', wt];
const WRITE = () => [...ARGS(), '--confirm-write'];
const editFile = () => (spec: ProcessSpec) => {
  writeFileSync(join(spec.cwd, 'a.txt'), 'one\nTWO\n');
  writeFileSync(join(spec.cwd, 'new.ts'), 'export {};\n');
  return undefined;
};
const mainState = () => ({ head: git(main, 'rev-parse', 'HEAD'), branch: git(main, 'branch', '--show-current'), status: git(main, 'status', '--porcelain'), file: readFileSync(join(main, 'a.txt'), 'utf8') });

describe('parseOrchestrateArgs: plan-implement-review', () => {
  const base = ['--workflow', 'plan-implement-review', '--task', 'x'];
  it('needs a workspace and an explicit write confirmation (or a dry run)', () => {
    for (const args of [
      [...base, '--confirm-write'],
      [...base, '--workspace', '/w'],
      [...base, '--workspace', '/w', '--confirm'],
      [...base, '--workspace', '/w', '--confirm-write', '--cwd', '/c'],
      [...base, '--workspace'],
      [...base, '--workspace', '/w', '--confirm-write', '--confirm-verify', '--verify-command', 'rm -rf x'],
      [...base, '--workspace', '/w', '--confirm-write', '--confirm-verify', '--verify-command', 'pnpm test; id'],
      // Verification runs newly written code outside any model sandbox: it needs its own approval.
      [...base, '--workspace', '/w', '--confirm-write', '--verify-command', 'pnpm test'],
      [...base, '--workspace', '/w', '--confirm-write', '--confirm-verify'],
    ]) {
      expect(typeof parseOrchestrateArgs(args)).toBe('string');
    }
    expect(parseOrchestrateArgs([...base, '--workspace', '/w', '--dry-run'])).toMatchObject({ workspace: '/w', dryRun: true });
    expect(parseOrchestrateArgs([...base, '--workspace', '/w', '--confirm-write', '--verify-command', 'pnpm test', '--confirm-verify'])).toMatchObject({
      confirmWrite: true,
      confirmVerify: true,
      verify: { command: 'pnpm', args: ['test'] },
    });
  });

  it('keeps the write options out of plan-review', () => {
    for (const extra of [['--workspace', '/w'], ['--confirm-write'], ['--verify-command', 'pnpm test'], ['--confirm-verify'], ['--allow-partial-ignored-check']]) {
      expect(typeof parseOrchestrateArgs(['--workflow', 'plan-review', '--task', 'x', '--confirm', ...extra])).toBe('string');
    }
  });
});

describe('orchestrate plan-implement-review --dry-run', () => {
  it('shows the workspace state, limits and guarantees without starting anything or writing', async () => {
    const before = mainState();
    const r = await go([...ARGS(), '--dry-run', '--verify-command', 'pnpm test']);
    expect(r.code).toBe(0);
    expect(r.commands).toEqual([]);
    expect(r.out).toContain('workspace check: ok');
    expect(r.out).toContain('branch: feature');
    expect(r.out).toContain('main worktree:');
    expect(r.out).toContain('implement [codex]: WRITE sandbox limited to the workspace');
    expect(r.out).toContain('inspect [local]');
    expect(r.out).toContain('RUNS THE NEWLY WRITTEN CODE OUTSIDE ANY MODEL SANDBOX');
    expect(r.out).toContain('requires: --confirm-write, --confirm-verify');
    expect(r.out).toContain('ignored files too');
    expect(r.out).toContain('review input: tracked diff plus new text files in full');
    expect(r.out).toContain('no commit, no push');
    expect(r.out).toContain('no workspace creation');
    expect(r.out).toContain('the workspace keeps whatever was written');
    expect(r.out).toContain('requires: --confirm-write');
    expect(r.out).toContain('verdict: would run');
    expect(r.out).not.toContain('add a --json flag');
    expect(mainState()).toEqual(before);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('reports why a workspace would be refused', async () => {
    writeFileSync(join(wt, 'dirty.txt'), 'x');
    const dirty = await go([...ARGS(), '--dry-run']);
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain('rejected: workspace-dirty');
    expect(dirty.out).toContain('uncommitted or untracked changes');
    const onMain = await go(['orchestrate', '--workflow', 'plan-implement-review', '--task', 'x', '--workspace', main, '--dry-run']);
    expect(onMain.code).toBe(1);
    expect(onMain.out).toContain('not-a-linked-worktree');
    expect(onMain.out).toContain('verdict: would refuse');
    const missing = await go(['orchestrate', '--workflow', 'plan-implement-review', '--task', 'x', '--workspace', join(root, 'nope'), '--dry-run']);
    expect(missing.code).toBe(1);
    expect(missing.error).toContain('does not exist');
    rmSync(join(wt, 'dirty.txt'));
    mkdirSync(join(wt, 'sub'));
    const sub = await go(['orchestrate', '--workflow', 'plan-implement-review', '--task', 'x', '--workspace', join(wt, 'sub'), '--dry-run']);
    expect(sub.code).toBe(1);
    expect(sub.out).toContain('must be the worktree root');
  });
});

describe('orchestrate plan-implement-review --confirm-write', () => {
  it('refuses the main worktree, a dirty or protected workspace and a non-repository before starting anything', async () => {
    const cases: [string, () => void][] = [
      [main, () => undefined],
      [wt, () => { writeFileSync(join(wt, 'dirty.txt'), 'x'); }],
      [root, () => undefined],
    ];
    for (const [workspace, prepare] of cases) {
      prepare();
      const argv = ['orchestrate', '--workflow', 'plan-implement-review', '--task', 'x', '--workspace', workspace, '--confirm-write'];
      const r = await go(argv);
      expect(r.code).toBe(1);
      expect(r.commands).toEqual([]);
      expect(r.error).toContain('no step was started and nothing was written');
    }
    git(wt, 'checkout', '-q', '-f', '-B', 'main-copy');
    rmSync(join(wt, 'dirty.txt'), { force: true });
    git(wt, 'branch', '-m', 'develop');
    const protectedBranch = await go(WRITE());
    expect(protectedBranch.code).toBe(1);
    expect(protectedBranch.error).toContain('protected branch');
    expect(protectedBranch.commands).toEqual([]);
  });

  it('plans, writes in the worktree, inspects, verifies and reviews, leaving main and history untouched', async () => {
    const before = mainState();
    const headBefore = git(wt, 'rev-parse', 'HEAD');
    const r = await go([...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'], { onCodex: editFile() });
    expect(r.code).toBe(0);
    expect(r.commands).toEqual(['claude', 'codex', 'pnpm', 'claude']);
    expect(r.specs[1]?.args).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(r.specs.every((s) => s.cwd === wt)).toBe(true);
    expect(r.specs[2]).toMatchObject({ command: 'pnpm', args: ['test'] });
    expect(r.out).toMatch(/inspect\s+local\s+completed/);
    expect(r.out).toContain('policy: ok');
    expect(r.out).toContain('+TWO');
    expect(r.out).toContain('new  new.ts');
    expect(r.out).toContain('summary: plan-implement-review completed');
    expect(r.out).toContain('Nothing was committed or pushed.');
    expect(r.out).not.toContain('partial changes');
    const review = r.specs[3]?.input ?? '';
    expect(review).toContain('<<<BEGIN UNTRUSTED CHANGES NONCE>>>');
    expect(review).toContain('+TWO');
    expect(review).toContain('+export {};');
    expect(review).toContain('review input: complete');
    expect(review).toContain('result: passed');
    // The implementation lives only in the worktree; nothing was committed.
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(wt, 'status', '--porcelain')).toContain('a.txt');
    expect(mainState()).toEqual(before);
  });

  it('stops when the step commits, reporting the policy violation and the real state', async () => {
    const r = await go(WRITE(), {
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'a.txt'), 'sneaky\n');
        git(spec.cwd, 'commit', '-q', '-am', 'sneaky');
        return undefined;
      },
    });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual(['claude', 'codex']);
    expect(r.out).toMatch(/inspect\s+local\s+failed\s+\S+\s+error: workspace policy: head-moved/);
    expect(r.out).toMatch(/review\s+claude\s+skipped/);
    expect(r.out).toContain('partial changes');
    expect(git(main, 'rev-parse', 'main')).not.toBe(git(wt, 'rev-parse', 'HEAD'));
  });

  it('stops when the step touches a protected path or exceeds the limits, leaving files in place', async () => {
    const r = await go(WRITE(), {
      onCodex: (spec) => {
        mkdirSync(join(spec.cwd, '.github', 'workflows'), { recursive: true });
        writeFileSync(join(spec.cwd, '.github', 'workflows', 'ci.yml'), 'on: push\n');
        return undefined;
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('error: workspace policy: protected-path');
    expect(existsSync(join(wt, '.github', 'workflows', 'ci.yml'))).toBe(true);
    expect(r.commands).toEqual(['claude', 'codex']);
  });

  it('on an implementation failure still reports the workspace state and warns about partial changes', async () => {
    const r = await go(WRITE(), {
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'half.txt'), 'partial\n');
        return { kind: 'completed', exitCode: 1, stdout: 'raw sk-secret', truncated: false };
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/implement\s+codex\s+failed/);
    expect(r.out).toMatch(/inspect\s+local\s+completed/);
    expect(r.out).toContain('new  half.txt');
    expect(r.out).toContain('The workspace may contain partial changes; nothing was reverted.');
    expect(r.out + r.error).not.toContain('sk-secret');
    expect(existsSync(join(wt, 'half.txt'))).toBe(true);
  });

  it('cancels during the implementation: exit 130, state reported, nothing after it runs', async () => {
    const controller = new AbortController();
    const r = await go([...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'], {
      signal: controller.signal,
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'half.txt'), 'partial\n');
        controller.abort();
        return { kind: 'cancelled' };
      },
    });
    expect(r.code).toBe(130);
    expect(r.commands).toEqual(['claude', 'codex']);
    expect(r.out).toMatch(/implement\s+codex\s+cancelled/);
    expect(r.out).toMatch(/inspect\s+local\s+completed/);
    expect(r.out).toMatch(/verify\s+local\s+skipped/);
    expect(r.out).toContain('new  half.txt');
    expect(r.out).toContain('summary: plan-implement-review cancelled');
  });

  it('stops before the review when verification fails, and shows the verification result', async () => {
    const r = await go([...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'], {
      onCodex: editFile(),
      onVerify: () => ({ kind: 'completed', exitCode: 1, stdout: '1 test failed\n', truncated: false }),
    });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual(['claude', 'codex', 'pnpm']);
    expect(r.out).toContain('result: failed (exit 1)');
    expect(r.out).toContain('1 test failed');
    expect(r.out).toMatch(/review\s+claude\s+skipped/);
    expect(r.out).toContain('error: verification failed (exit 1)');
  });

  it('times out a step with a fixed message and does not retry', async () => {
    const r = await go(WRITE(), { claude: [{ kind: 'timeout' }] });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual(['claude']);
    expect(r.out).toMatch(/plan\s+claude\s+timeout/);
    expect(r.out).toMatch(/implement\s+codex\s+skipped/);
    expect(r.out).toContain('did not start');
    expect(r.out).not.toContain('partial changes');
  });
});

describe('orchestrate plan-implement-review: review integrity and verification safety', () => {
  const withVerify = () => [...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'];

  it('rejects ignored-file changes that git status does not show', async () => {
    writeFileSync(join(main, '.git', 'info', 'exclude'), 'cache/\n');
    mkdirSync(join(wt, 'cache'));
    writeFileSync(join(wt, 'cache', 'a.bin'), 'x');
    const r = await go(WRITE(), {
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'cache', 'a.bin'), 'changed by the step');
        writeFileSync(join(spec.cwd, 'a.txt'), 'one\nTWO\n');
        return undefined;
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('error: workspace policy: ignored-file-changed');
    expect(r.out).toMatch(/review\s+claude\s+skipped/);
    expect(r.commands).toEqual(['claude', 'codex']);
  });

  it('never approves on an incomplete diff: the change is rejected and the review is skipped', async () => {
    const r = await go(WRITE(), {
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'big.ts'), 'export const v = 1;\n'.repeat(700));
        return undefined;
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('review-incomplete');
    expect(r.out).toContain('no approval can be based on it');
    expect(r.commands).toEqual(['claude', 'codex']);
  });

  it('refuses to run the verification when build or test configuration was changed', async () => {
    const r = await go(withVerify(), {
      onCodex: (spec) => {
        writeFileSync(join(spec.cwd, 'package.json'), '{"scripts":{"test":"echo pwned"}}');
        return undefined;
      },
    });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual(['claude', 'codex']);
    expect(r.out).toContain('error: verification refused: changed files can alter what the test command runs');
    expect(r.out).toContain('package.json');
    expect(r.out).toMatch(/review\s+claude\s+skipped/);
  });

  it('fails when the verification wrote into the main worktree or moved history', async () => {
    writeFileSync(join(main, 'wip.txt'), 'mine');
    const r = await go(withVerify(), {
      onCodex: editFile(),
      onVerify: () => {
        writeFileSync(join(main, 'wip.txt'), 'clobbered by the code under test');
        return done('tests passed\n');
      },
    });
    expect(r.code).toBe(1);
    expect(r.commands).toEqual(['claude', 'codex', 'pnpm']);
    expect(r.out).toContain('error: workspace policy after verification: main-worktree-changed');
    expect(r.out).toContain('result: passed');
    expect(r.out).toMatch(/review\s+claude\s+skipped/);
  });

  it('does not run the verification command without its own approval flag', async () => {
    const r = await go([...WRITE(), '--verify-command', 'pnpm test']);
    expect(r.code).toBe(2);
    expect(r.error).toContain('--confirm-verify');
    expect(r.commands).toEqual([]);
  });
});

describe('plan-implement-review: per-step model and effort', () => {
  const PICK = ['--step-model', 'implement=gpt-a', '--step-effort', 'implement=low', '--step-model', 'review=claude-x', '--step-effort', 'review=high'];

  it('rejects bad selections while parsing, before anything is checked or started', () => {
    const base = ['--workflow', 'plan-implement-review', '--task', 'x', '--workspace', '/w', '--dry-run'];
    for (const extra of [
      ['--step-model', 'plan'],
      ['--step-model', 'plan='],
      ['--step-model', '=x'],
      ['--step-model', 'verify=x'],
      ['--step-model', 'plan=a', '--step-model', 'plan=b'],
      ['--step-model', 'plan=bad id'],
      ['--step-effort', 'review=ultracode'],
      ['--step-effort', 'review=HIGH!'],
      ['--step-effort'],
    ]) {
      expect(typeof parseOrchestrateArgs([...base, ...extra])).toBe('string');
    }
    expect(parseOrchestrateArgs([...base, ...PICK])).toMatchObject({ steps: { implement: { request: { model: 'gpt-a', effort: 'low', mode: 'normal' }, modelFromFlag: true } } });
  });

  it('shows model, effort, verification status and reason for every step in a dry run', async () => {
    const r = await go([...ARGS(), '--dry-run', ...PICK]);
    expect(r.code).toBe(1);
    expect(r.commands).toEqual([]);
    expect(r.out).toContain('model: provider-default; reason: no flag');
    expect(r.out).toContain('verification: nothing pinned, nothing to verify');
    expect(r.out).toContain('model: gpt-a (verified); reason: requested with --step-model implement=gpt-a');
    expect(r.out).toContain('effort: low (verified); reason: requested with --step-effort implement=low');
    expect(r.out).toContain('model: claude-x (unverified); reason: requested with --step-model review=claude-x');
    expect(r.out).toContain('verification: UNVERIFIED (needs --accept-unverified)');
    expect(r.out).toContain('model-access-unverified');
    expect(r.out).toContain('requires: --confirm-write, --accept-unverified');
    expect(r.out).toContain('verdict: would refuse');
    expect(r.out).toContain('ultracode never selected');
    const ok = await go([...ARGS(), '--dry-run', ...PICK, '--accept-unverified']);
    expect(ok.out).toContain('verdict: would run');
    expect(ok.code).toBe(0);
  });

  it('blocks an effort the pinned model does not support', async () => {
    const r = await go([...ARGS(), '--dry-run', '--step-model', 'implement=gpt-a', '--step-effort', 'implement=max', '--accept-unverified']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('verification: BLOCKED');
    expect(r.out).toContain('effort-unsupported');
    const real = await go([...WRITE(), '--step-model', 'implement=gpt-a', '--step-effort', 'implement=max']);
    expect(real.code).toBe(1);
    expect(real.commands).toEqual([]);
    expect(real.error).toContain('step implement [codex]');
  });

  it('refuses an unknown codex model without starting any step', async () => {
    const r = await go([...WRITE(), '--step-model', 'implement=nope']);
    expect(r.code).toBe(1);
    expect(r.commands).toEqual([]);
    expect(r.error).toContain('model-not-listed');
  });

  it('passes each step its own selection to the right provider and keeps unrelated steps on the default', async () => {
    const r = await go([...WRITE(), ...PICK, '--accept-unverified'], { onCodex: editFile() });
    expect(r.code).toBe(0);
    const [plan, codex, review] = r.specs.filter((s) => s.command !== 'git' || false);
    expect(plan?.command).toBe('claude');
    expect(plan?.args).not.toContain('--model');
    expect(plan?.args).not.toContain('--effort');
    expect(codex?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=low']));
    expect(review?.command).toBe('claude');
    expect(review?.args).toEqual(expect.arrayContaining(['--model', 'claude-x', '--effort', 'high']));
  });

  it('keeps the provider defaults when no step flags are given', async () => {
    const r = await go([...WRITE()], { onCodex: editFile() });
    expect(r.code).toBe(0);
    for (const spec of r.specs) {
      expect(spec.args).not.toContain('--model');
      expect(spec.args).not.toContain('-m');
    }
  });
});

describe('plan-implement-review: --policy', () => {
  it('applies to the implement step of a pinned model, shows the policy line and keeps manual settings first', async () => {
    const dry = await go([...ARGS(), '--dry-run', '--step-model', 'implement=gpt-a', '--policy', 'economy']);
    expect(dry.out).toContain('policy: economy;');
    expect(dry.out).toContain('effort: low (verified); reason: policy economy: low (economy base low');
    expect(dry.out).toContain('policy economy: provider default kept: the model is not pinned');
    const real = await go([...WRITE(), '--step-model', 'implement=gpt-a', '--policy', 'quality'], { onCodex: editFile() });
    expect(real.code).toBe(0);
    const codex = real.specs.find((s) => s.command === 'codex');
    expect(codex?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=medium']));
  });

  it('keeps a manual effort over the policy', async () => {
    const manual = await go([...WRITE(), '--step-model', 'implement=gpt-a', '--step-effort', 'implement=low', '--policy', 'quality'], { onCodex: editFile() });
    expect(manual.specs.find((s) => s.command === 'codex')?.args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=low']));
  });

  it('never changes Claude steps: their per-model efforts are not verifiable', async () => {
    const r = await go([...WRITE(), '--step-model', 'plan=claude-sonnet-5-5', '--policy', 'quality', '--accept-unverified'], { onCodex: editFile() });
    expect(r.code).toBe(0);
    const claude = r.specs.filter((s) => s.command === 'claude');
    expect(claude[0]?.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5']));
    for (const spec of claude) expect(spec.args).not.toContain('--effort');
  });
});

describe('plan-implement-review: --model-routing adaptive', () => {
  it('keeps Claude steps and a single-model Codex list on their defaults, and shows why', async () => {
    const dry = await go([...ARGS(), '--dry-run', '--model-routing', 'adaptive']);
    expect(dry.out).toContain('model routing: adaptive');
    expect(dry.out.match(/claude access: UNKNOWN/g)).toHaveLength(2);
    expect(dry.out).toContain('the list offers no alternative to choose between');
    const real = await go([...WRITE(), '--model-routing', 'adaptive'], { onCodex: editFile() });
    expect(real.code).toBe(0);
    for (const spec of real.specs) expect(spec.args).not.toContain('--model');
  });
});

const memory = (initial: OutcomeRecord[] = []): OutcomeStore & { saved: OutcomeRecord[] } => {
  const saved = [...initial];
  return { saved, load: () => Promise.resolve([...saved]), append: (r) => { saved.push(...r); return Promise.resolve(); }, clear: () => { saved.length = 0; return Promise.resolve(); } };
};
const rec = (model: string, effort: string, outcome: OutcomeRecord['outcome']): OutcomeRecord => ({ v: 1, day: '2026-10-20', step: 'implement', provider: 'codex', model, effort, task: 'general', size: 'small', outcome, seconds: 20 });
const SPREAD = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const rows = (model: string, effort: string, pass: number, fail: number, group?: string): OutcomeRecord[] =>
  [...Array.from({ length: pass }, () => 'pass' as const), ...Array.from({ length: fail }, () => 'fail' as const)].map((outcome, i) => ({
    ...rec(model, effort, outcome),
    day: SPREAD[i % 4] ?? '2026-10-20',
    ...(group === undefined ? {} : { group }),
  }));

describe('plan-implement-review: outcome records and --model-routing measured', () => {
  it('records objective results only, without task text or paths, and not with --no-record', async () => {
    const store = memory();
    const ok = await go([...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'], { onCodex: editFile(), outcomes: store });
    expect(ok.code).toBe(0);
    expect(store.saved.map((r) => [r.step, r.outcome])).toEqual([['plan', 'unmeasured'], ['implement', 'pass'], ['review', 'unmeasured']]);
    expect(ok.error).toContain('3 step result(s) recorded locally');
    expect(JSON.stringify(store.saved)).not.toMatch(/json flag|a\.txt|NONCE|\/wt|acl wr/);
    git(wt, 'reset', '--hard', '-q');
    git(wt, 'clean', '-fdq');
    const failed = await go([...WRITE(), '--verify-command', 'pnpm test', '--confirm-verify'], { onCodex: editFile(), onVerify: () => ({ kind: 'completed', exitCode: 1, stdout: 'x', truncated: false }), outcomes: store });
    expect(failed.code).toBe(1);
    expect(store.saved.filter((r) => r.step === 'implement').map((r) => r.outcome)).toEqual(['pass', 'fail']);
    git(wt, 'reset', '--hard', '-q');
    git(wt, 'clean', '-fdq');
    const off = memory();
    const quiet = await go([...WRITE(), '--no-record'], { onCodex: editFile(), outcomes: off });
    expect(off.saved).toEqual([]);
    expect(quiet.error).toContain('not recorded (--no-record)');
  });

  it('records nothing for a dry run and tolerates a failing store', async () => {
    const store = memory();
    await go([...ARGS(), '--dry-run'], { outcomes: store });
    expect(store.saved).toEqual([]);
    const broken: OutcomeStore = { load: () => Promise.reject(new Error('disk')), append: () => Promise.reject(new Error('disk')), clear: () => Promise.reject(new Error('disk')) };
    const r = await go([...WRITE(), '--model-routing', 'measured'], { onCodex: editFile(), outcomes: broken });
    expect(r.code).toBe(0);
    expect(r.error).toContain('could not be recorded locally');
  });

  it('reports a locked store as not recorded, with the way to recover, and does not fail the run', async () => {
    const locked: OutcomeStore = { load: () => Promise.resolve([]), append: () => Promise.reject(new OutcomeStoreLockedError('/cache/outcomes.lock')), clear: () => Promise.resolve() };
    const r = await go([...WRITE()], { onCodex: editFile(), outcomes: locked });
    expect(r.code).toBe(0);
    expect(r.error).toContain('not recorded, the store is locked');
    expect(r.error).toContain('/cache/outcomes.lock');
    expect(r.error).toContain('docs/ORCHESTRATE.md');
  });

  it('keeps the provider default and shows the data amount when there is not enough data', async () => {
    const dry = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory(rows('gpt-a', 'low', 3, 0)) });
    expect(dry.out).toContain('model routing: measured');
    expect(dry.out).toContain('provider default kept: not enough comparable data');
    expect(dry.out).toContain('evidence: measured outcomes (pass or fail by a local check, never the model\'s own claim): 3 in 1 group(s)');
    expect(dry.out).toContain('gpt-a / low: 3 pass, 0 fail');
    const none = await go([...ARGS(), '--dry-run', '--model-routing', 'measured']);
    expect(none.out).toContain('no local outcome store available');
  });

  it('pins the clearly better listed model with its effort, starts it, and shows the uncertainty', async () => {
    const data = [...rows('gpt-a', 'low', 20, 0), ...rows('default', 'default', 5, 10)];
    const dry = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory(data) });
    expect(dry.out).toContain('model: gpt-a (verified); reason: adaptive routing: gpt-a / low: measurably better');
    expect(dry.out).toContain('uncertainty: gpt-a / low lower bound');
    expect(dry.out).toContain('gpt-a is listed by the provider now and supports low');
    expect(dry.out).toContain('effort: low (verified); reason: policy balanced: the effort comes from the measured group');
    const live = await go([...WRITE(), '--model-routing', 'measured'], { onCodex: editFile(), outcomes: memory(data) });
    expect(live.specs.find((s) => s.command === 'codex')?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=low']));
    for (const spec of live.specs.filter((s) => s.command === 'claude')) expect(spec.args).not.toContain('--model');
  });

  it('does not pin a model the provider no longer lists or an effort it no longer supports, and manual choices win', async () => {
    const gone = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory([...rows('gpt-z', 'low', 20, 0), ...rows('default', 'default', 5, 10)]) });
    expect(gone.out).toContain('provider default kept: gpt-z is not in the Codex model list now');
    const noEffort = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory([...rows('gpt-a', 'high', 20, 0), ...rows('default', 'default', 5, 10)]) });
    expect(noEffort.out).toContain('gpt-a is not reported to support high now');
    const manual = await go([...ARGS(), '--dry-run', '--model-routing', 'measured', '--step-model', 'implement=gpt-a'], { outcomes: memory([...rows('gpt-a', 'low', 20, 0), ...rows('default', 'default', 5, 10)]) });
    expect(manual.out).toContain('reason: requested with --step-model implement=gpt-a');
  });

  it('compares only within a user-defined test group, tags new records with it and rejects non-neutral labels', async () => {
    const tagged = [...rows('gpt-a', 'low', 20, 0, 'suite-a'), ...rows('default', 'default', 5, 10, 'suite-a')];
    const plain = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory(tagged) });
    expect(plain.out).toContain('provider default kept: not enough comparable data');
    const grouped = await go([...ARGS(), '--dry-run', '--model-routing', 'measured', '--eval-group', 'suite-a'], { outcomes: memory(tagged) });
    expect(grouped.out).toContain('test group "suite-a"');
    expect(grouped.out).toContain('model: gpt-a (verified)');
    const store = memory();
    await go([...WRITE(), '--eval-group', 'suite-a'], { onCodex: editFile(), outcomes: store });
    expect(store.saved.length).toBeGreaterThan(0);
    expect(store.saved.every((r) => r.group === 'suite-a')).toBe(true);
    for (const bad of ['', 'My Task', 'fix the login bug please']) {
      expect(typeof parseOrchestrateArgs(['--workflow', 'plan-review', '--task', 'x', '--dry-run', '--eval-group', bad])).toBe('string');
    }
  });

  it('shows errors and timeouts in the dry run and keeps the default when they explain the win', async () => {
    const flaky = [...rows('gpt-a', 'low', 20, 0), ...Array.from({ length: 16 }, (_, i) => ({ ...rec('gpt-a', 'low', i % 2 === 0 ? 'timeout' : 'error'), day: SPREAD[i % 4] ?? '2026-10-20' })), ...rows('default', 'default', 5, 10)];
    const dry = await go([...ARGS(), '--dry-run', '--model-routing', 'measured'], { outcomes: memory(flaky) });
    expect(dry.out).toContain('8 error, 8 timeout');
    expect(dry.out).toContain('the better pass rate comes with too many errors or timeouts');
    expect(dry.out).not.toContain('model: gpt-a');
  });
});

describe('plan-implement-review: per-step provider', () => {
  const combos = [['claude', 'claude'], ['claude', 'codex'], ['codex', 'claude'], ['codex', 'codex']] as const;
  const sandboxOf = (args: readonly string[]): string | undefined => args[args.indexOf('-s') + 1];

  it.each(combos)('plan on %s, review on %s: dry run names the providers and starts nothing', async (plan, review) => {
    const r = await go([...ARGS(), '--dry-run', '--step-provider', `plan=${plan}`, '--step-provider', `review=${review}`]);
    expect(r.code).toBe(0);
    expect(r.commands).toEqual([]);
    expect(r.out).toContain(`step 1/4 plan [${plan}]`);
    expect(r.out).toContain('implement [codex]: WRITE sandbox');
    expect(r.out).toContain(`step 4/4 review [${review}]`);
  });

  it.each(combos)('plan on %s, review on %s: only the implement step gets a write sandbox', async (plan, review) => {
    const r = await go([...WRITE(), '--step-provider', `plan=${plan}`, '--step-provider', `review=${review}`], { onCodex: editFile() });
    expect(r.code).toBe(0);
    const model = r.specs.filter((s) => s.command === 'claude' || s.command === 'codex');
    expect(model.map((s) => s.command)).toEqual([plan, 'codex', review]);
    const sandboxes = model.map((s) => (s.command === 'codex' ? sandboxOf(s.args) : undefined));
    expect(sandboxes[1]).toBe('workspace-write');
    for (const i of [0, 2]) if (model[i]?.command === 'codex') expect(sandboxes[i]).toBe('read-only');
    expect(mainState().status).toBe('');
  });

  it('refuses a Claude implementation, in either order, before anything starts', () => {
    for (const flags of [['--step-provider', 'implement=claude'], ['--step-provider', 'review=codex', '--step-provider', 'implement=claude']]) {
      expect(typeof parseOrchestrateArgs([...ARGS(), '--dry-run', ...flags])).toBe('string');
    }
  });

  it('checks a manual model against the chosen provider for every step', async () => {
    const wrongPlan = await go([...WRITE(), '--step-provider', 'plan=codex', '--step-model', 'plan=claude-x', '--accept-unverified']);
    expect(wrongPlan.code).toBe(1);
    expect(wrongPlan.commands).toEqual([]);
    expect(wrongPlan.error).toContain('step plan [codex]');
    const wrongReview = await go([...WRITE(), '--step-provider', 'review=codex', '--step-model', 'review=nope']);
    expect(wrongReview.code).toBe(1);
    expect(wrongReview.commands).toEqual([]);
    const good = await go([...WRITE(), '--step-provider', 'plan=codex', '--step-model', 'plan=gpt-a', '--step-effort', 'plan=low', '--step-provider', 'review=codex', '--step-model', 'review=gpt-a'], { onCodex: editFile() });
    expect(good.code).toBe(0);
    const codexSpecs = good.specs.filter((s) => s.command === 'codex');
    expect(codexSpecs).toHaveLength(3);
    expect(codexSpecs[0]?.args).toEqual(expect.arrayContaining(['-m', 'gpt-a', '-c', 'model_reasoning_effort=low']));
  });
});
