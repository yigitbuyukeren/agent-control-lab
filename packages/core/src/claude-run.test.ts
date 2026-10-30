import { describe, expect, it } from 'vitest';
import type { AuthStatus } from './auth.ts';
import {
  MIN_ULTRACODE_VERSION,
  buildClaudePrintArgs,
  claudeRunEnv,
  compareVersions,
  planClaudeRun,
  runClaude,
} from './claude-run.ts';
import { claudeRegistry } from './models.ts';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';
import { DEFAULT_REQUEST, resolveSelection, type SelectionRequest } from './selection.ts';

const selectionFor = (r: Partial<SelectionRequest> = {}) =>
  resolveSelection('claude', { ...DEFAULT_REQUEST, ...r }, { claude: claudeRegistry, codex: { state: 'ok', models: [] } });
const auth = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  id: 'claude-code',
  displayName: 'Claude Code',
  state: 'logged-in',
  method: 'subscription',
  plan: 'pro',
  ...over,
});

describe('buildClaudePrintArgs', () => {
  it('is tool-less, MCP-less, customisation-less, non-persistent and prompt-denying', () => {
    expect(buildClaudePrintArgs(selectionFor())).toEqual([
      '-p', '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands',
      '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'text',
    ]);
  });

  it('passes an explicit model and effort, and ultracode through --effort', () => {
    const tail = (r: Partial<SelectionRequest>) => buildClaudePrintArgs(selectionFor(r)).slice(11);
    expect(tail({ model: 'claude-opus-5-5', effort: 'high' })).toEqual(['--model', 'claude-opus-5-5', '--effort', 'high']);
    expect(tail({ mode: 'ultracode' })).toEqual(['--effort', 'ultracode']);
  });

  it('never builds a permission-widening, key-based or tool-enabling flag', () => {
    const joined = buildClaudePrintArgs(selectionFor({ model: 'claude-opus-5-5', effort: 'max' })).join(' ');
    for (const bad of ['bypass', 'dangerously', 'acceptEdits', 'allowedTools', '--mcp-config', '--bare', '--add-dir', 'api-key', '--settings']) {
      expect(joined).not.toContain(bad);
    }
  });
});

describe('claudeRunEnv', () => {
  it('keeps only what the child needs and drops credentials, overrides and parent-session variables', () => {
    const env = claudeRunEnv({
      PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', CLAUDE_CONFIG_DIR: '/cfg', HTTPS_PROXY: 'p',
      ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_MODEL: 'm',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', AWS_BEARER_TOKEN_BEDROCK: 'b', AWS_ACCESS_KEY_ID: 'a',
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_CODE_MESSAGING_TOKEN: 'm', OPENAI_API_KEY: 'o', RANDOM_SECRET: 's',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', CLAUDE_CONFIG_DIR: '/cfg', HTTPS_PROXY: 'p' });
  });
});

describe('compareVersions', () => {
  it('orders versions and gives up on garbage', () => {
    expect(compareVersions('2.1.312', '2.1.312')).toBe(0);
    expect(compareVersions('2.1.311', '2.1.312')).toBeLessThan(0);
    expect(compareVersions('2.2.0', '2.1.312')).toBeGreaterThan(0);
    expect(compareVersions('abc', '2.1.312')).toBeUndefined();
  });
});

describe('planClaudeRun', () => {
  const plan = (over: Partial<Parameters<typeof planClaudeRun>[0]> = {}) =>
    planClaudeRun({ task: 'hi', auth: auth(), selection: selectionFor(), version: '2.1.312', acceptUnverified: false, ...over });
  const reason = (over: Partial<Parameters<typeof planClaudeRun>[0]>) => {
    const p = plan(over);
    return p.ok ? 'ok' : p.reason;
  };

  it('allows a Pro or Max subscription on the first-party API', () => {
    expect(plan()).toEqual({ ok: true, warnings: [] });
    expect(reason({ auth: auth({ plan: 'max' }) })).toBe('ok');
  });

  it('refuses everything that is not a verified subscription, with distinct reasons', () => {
    expect(reason({ auth: auth({ method: 'api-key' }) })).toBe('api-key-login');
    expect(reason({ auth: auth({ method: 'third-party' }) })).toBe('third-party-provider');
    expect(reason({ auth: auth({ method: 'unknown' }) })).toBe('not-a-subscription-plan');
    expect(reason({ auth: auth({ plan: 'free' }) })).toBe('not-a-subscription-plan');
    const noPlan: AuthStatus = { id: 'claude-code', displayName: 'Claude Code', state: 'logged-in', method: 'subscription' };
    expect(reason({ auth: noPlan })).toBe('not-a-subscription-plan');
    expect(reason({ auth: auth({ state: 'logged-out' }) })).toBe('not-logged-in');
    expect(reason({ auth: auth({ state: 'not-installed' }) })).toBe('claude-not-installed');
    expect(reason({ auth: auth({ state: 'unknown' }) })).toBe('login-state-unknown');
    expect(reason({ auth: auth({ state: 'error' }) })).toBe('login-state-unknown');
    expect(reason({ task: '' })).toBe('task-invalid');
  });

  it('refuses blocking selections even when unverified issues are accepted', () => {
    for (const acceptUnverified of [false, true]) {
      expect(plan({ selection: selectionFor({ effort: 'ultra' }), acceptUnverified })).toMatchObject({ reason: 'selection-blocked' });
      expect(plan({ selection: selectionFor({ mode: 'ultracode', effort: 'high' }), acceptUnverified })).toMatchObject({
        reason: 'selection-blocked',
        issues: [{ code: 'mode-effort-conflict' }],
      });
    }
  });

  it('needs acceptance for unverified model, effort and ultracode', () => {
    for (const r of [{ model: 'claude-opus-5-5' }, { effort: 'high' }, { mode: 'ultracode' as const }]) {
      expect(plan({ selection: selectionFor(r) })).toMatchObject({ ok: false, reason: 'unverified-selection' });
      expect(plan({ selection: selectionFor(r), acceptUnverified: true })).toMatchObject({ ok: true });
    }
  });

  it('gates ultracode on the verified CLI version', () => {
    const selection = selectionFor({ mode: 'ultracode' });
    expect(MIN_ULTRACODE_VERSION).toBe('2.1.312');
    expect(plan({ selection, version: '2.1.311', acceptUnverified: true })).toMatchObject({ reason: 'claude-version-unsupported' });
    expect(plan({ selection, version: '2.1.312', acceptUnverified: true })).toMatchObject({ ok: true });
    expect(plan({ selection, version: undefined, acceptUnverified: true })).toMatchObject({ ok: true });
  });
});

describe('runClaude (mock runner)', () => {
  const run = async (outcome: ProcessOutcome, timeoutMs = 1000) => {
    const specs: ProcessSpec[] = [];
    const result = await runClaude(
      { task: 'hello', cwd: '/work', selection: selectionFor(), timeoutMs },
      { runner: (s) => { specs.push(s); return Promise.resolve(outcome); }, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' } },
    );
    return { result, spec: specs[0] as ProcessSpec };
  };

  it('starts claude with an explicit cwd, stdin prompt, bounded output and a cleaned environment', async () => {
    const { spec } = await run({ kind: 'completed', exitCode: 0, stdout: 'x', truncated: false });
    expect(spec).toMatchObject({ command: 'claude', cwd: '/work', input: 'hello', maxOutputBytes: 64 * 1024 });
    expect(spec.env).toEqual({ PATH: '/bin' });
  });

  it('returns sanitized output on success and fixed outcomes otherwise', async () => {
    expect((await run({ kind: 'completed', exitCode: 0, stdout: '\u001b[1mok\u001b[0m\n', truncated: false })).result).toEqual({ kind: 'completed', output: 'ok\n', truncated: false });
    expect((await run({ kind: 'completed', exitCode: 1, stdout: 'sk-leak', truncated: false })).result).toEqual({ kind: 'failed' });
    expect((await run({ kind: 'timeout' })).result).toEqual({ kind: 'timeout' });
    expect((await run({ kind: 'cancelled' })).result).toEqual({ kind: 'cancelled' });
    expect((await run({ kind: 'not-found' })).result).toEqual({ kind: 'not-installed' });
    expect((await run({ kind: 'spawn-failed' })).result).toEqual({ kind: 'spawn-failed' });
  });
});
