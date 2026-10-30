import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess, type Exec, type ProcessOutcome, type ProcessSpec } from '@agent-control-lab/core';
import { run } from './main.ts';
import { parseOrchestrateArgs } from './orchestrate.ts';

const AUTH_PRO = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro","email":"me@example.com"}';
const HELP = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--output-format <format>'].map((f) => `  ${f}  text`).join('\n');

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
      env: CLEAN_ENV,
      git: () => Promise.resolve('repo'),
      claudeSettings: () => Promise.resolve({ status: 'clean' }),
      clock: (() => { let t = 0; return () => (t += 1000); })(),
      nonce: () => 'NONCE',
      ...(scenario.signal === undefined ? {} : { signal: scenario.signal }),
      runner: (spec) => {
        if (spec.command === 'git') return runProcess(spec);
        specs.push(spec);
        if (spec.command === 'claude') {
          claudeCalls += 1;
          return Promise.resolve(scenario.claude?.[claudeCalls - 1] ?? done(claudeCalls === 1 ? 'PLAN: change a.txt' : 'VERDICT: approve'));
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
