import { describe, expect, it } from 'vitest';
import type { AuthStatus } from './auth.ts';
import {
  MIN_ULTRACODE_VERSION,
  buildClaudePrintArgs,
  claudeRunEnv,
  compareVersions,
  planClaudeRun,
  runClaude,
  parseClaudeJson,
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

const ok = (result: string, modelUsage?: Record<string, unknown>): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'SESSION-SECRET', ...(modelUsage === undefined ? {} : { modelUsage }) });

describe('parseClaudeJson', () => {
  it('keeps only the answer and the model ids named in modelUsage', () => {
    expect(parseClaudeJson(ok('hi', { 'claude-a': { inputTokens: 1 }, 'claude-b': {} }))).toEqual({ text: 'hi', usedModels: ['claude-a', 'claude-b'] });
    expect(parseClaudeJson(JSON.stringify([{ type: 'system' }, JSON.parse(ok('hi', { m: {} })) as object]))?.text).toBe('hi');
  });

  it('reports UNKNOWN (undefined) when the response names no usable model', () => {
    for (const usage of [undefined, {}, { 'bad id!': {} }, { 'claude-a': {}, 'bad id!': {} }]) {
      expect(parseClaudeJson(ok('hi', usage))).toEqual({ text: 'hi', usedModels: undefined });
    }
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${String(i)}`, {}]));
    expect(parseClaudeJson(ok('hi', many))?.usedModels).toBeUndefined();
  });

  it('rejects anything that is not a successful result with a text answer', () => {
    for (const bad of ['plain text', '', '[]', '{}', 'null', JSON.stringify({ type: 'result', is_error: true, result: 'x' }), JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'x' }), JSON.stringify({ type: 'result', result: 5 })]) {
      expect(parseClaudeJson(bad)).toBeUndefined();
    }
  });
});

describe('buildClaudePrintArgs', () => {
  it('is tool-less, MCP-less, customisation-less, non-persistent and prompt-denying', () => {
    expect(buildClaudePrintArgs(selectionFor())).toEqual([
      '-p', '--tools', '', '--strict-mcp-config', '--restricted', '--safe-mode', '--disable-slash-commands',
      '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'json',
    ]);
  });

  it('passes an explicit model and effort, and ultracode through --effort', () => {
    const tail = (r: Partial<SelectionRequest>) => buildClaudePrintArgs(selectionFor(r)).slice(12);
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
      PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', CLAUDE_CONFIG_DIR: '/cfg',
      ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_MODEL: 'm',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', AWS_BEARER_TOKEN_BEDROCK: 'b', AWS_ACCESS_KEY_ID: 'a',
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDE_CODE_MESSAGING_TOKEN: 'm', OPENAI_API_KEY: 'o', RANDOM_SECRET: 's',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', CLAUDE_CONFIG_DIR: '/cfg' });
  });

  it('does not forward proxy or TLS variables, in any case', () => {
    const env = claudeRunEnv({
      PATH: '/bin', HTTP_PROXY: 'a', https_proxy: 'b', ALL_PROXY: 'c', NO_PROXY: 'd', NODE_EXTRA_CA_CERTS: 'e',
      SSL_CERT_FILE: 'f', SSL_CERT_DIR: 'g', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--x',
    });
    expect(env).toEqual({ PATH: '/bin' });
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
    planClaudeRun({ task: 'hi', auth: auth(), selection: selectionFor(), version: '2.1.312', missingFlags: [], settings: { status: 'clean' }, acceptUnverified: false, ...over });
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
    expect(plan({ selection, version: undefined, acceptUnverified: true })).toMatchObject({ reason: 'claude-version-unknown' });
    expect(plan({ selection, version: 'weird', acceptUnverified: true })).toMatchObject({ reason: 'claude-version-unknown' });
    // An unknown version only matters for ultracode.
    expect(plan({ version: undefined })).toMatchObject({ ok: true });
  });
});

describe('planClaudeRun: network variables that are not forwarded', () => {
  const plan = (over: Partial<Parameters<typeof planClaudeRun>[0]> = {}) =>
    planClaudeRun({ task: 'hi', auth: auth(), selection: selectionFor(), version: '2.1.312', missingFlags: [], settings: { status: 'clean' }, acceptUnverified: false, ...over });

  it('refuses with a named reason unless the caller accepts running without them', () => {
    expect(plan({ networkRedirects: ['HTTPS_PROXY'] })).toMatchObject({ ok: false, reason: 'network-env-not-forwarded' });
    expect(plan({ networkRedirects: ['HTTPS_PROXY'], acceptUnverified: true })).toMatchObject({ ok: true });
    expect(plan({ networkRedirects: [] })).toMatchObject({ ok: true });
  });

  it('never outranks login, settings or flag refusals', () => {
    const networkRedirects = ['HTTPS_PROXY'];
    expect(plan({ networkRedirects, auth: auth({ method: 'api-key' }) })).toMatchObject({ reason: 'api-key-login' });
    expect(plan({ networkRedirects, missingFlags: undefined })).toMatchObject({ reason: 'claude-flags-unverified' });
    expect(plan({ networkRedirects, settings: { status: 'unsafe', findings: [] }, acceptUnverified: true })).toMatchObject({ reason: 'settings-unsafe' });
  });
});

describe('planClaudeRun: fail-closed hardening', () => {
  const plan = (over: Partial<Parameters<typeof planClaudeRun>[0]> = {}) =>
    planClaudeRun({ task: 'hi', auth: auth(), selection: selectionFor(), version: '2.1.312', missingFlags: [], settings: { status: 'clean' }, acceptUnverified: true, ...over });

  it('refuses when the CLI flags cannot be verified, with and without --accept-unverified', () => {
    for (const missingFlags of [undefined, ['--restricted'], ['--safe-mode', '--tools']]) {
      expect(plan({ missingFlags })).toMatchObject({ ok: false, reason: 'claude-flags-unverified' });
    }
  });

  it('refuses unsafe settings and reports only key names', () => {
    const findings = [{ kind: 'user' as const, key: 'env.ANTHROPIC_BASE_URL' }, { kind: 'project' as const, key: 'apiKeyHelper' }];
    const result = plan({ settings: { status: 'unsafe', findings } });
    expect(result).toMatchObject({ ok: false, reason: 'settings-unsafe', findings });
  });

  it('refuses settings that cannot be read or parsed', () => {
    for (const problem of ['unreadable', 'invalid', 'too-large', 'repo-unresolved'] as const) {
      expect(plan({ settings: { status: 'unverifiable', kind: 'user', problem } })).toMatchObject({ reason: 'settings-unverifiable' });
    }
  });

  it('cannot be bypassed by --accept-unverified, and still checks login first', () => {
    expect(plan({ auth: auth({ method: 'api-key' }), settings: { status: 'unsafe', findings: [] } })).toMatchObject({ reason: 'api-key-login' });
    expect(plan({ settings: { status: 'unsafe', findings: [] }, acceptUnverified: true })).toMatchObject({ ok: false });
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
    const { spec } = await run({ kind: 'completed', exitCode: 0, stdout: ok('x'), truncated: false });
    expect(spec).toMatchObject({ command: 'claude', cwd: '/work', input: 'hello', maxOutputBytes: 80 * 1024 });
    expect(spec.env).toEqual({ PATH: '/bin' });
  });

  it('never carries the session id or other envelope fields, and shows UNKNOWN when no model is reported', async () => {
    const { result } = await run({ kind: 'completed', exitCode: 0, stdout: ok('answer'), truncated: false });
    expect(result).toEqual({ kind: 'completed', output: 'answer', truncated: false });
    expect(JSON.stringify(result)).not.toContain('SESSION-SECRET');
  });

  it('cuts an answer above the output limit instead of failing', async () => {
    const { result } = await run({ kind: 'completed', exitCode: 0, stdout: ok('a'.repeat(64 * 1024 + 10)), truncated: false });
    expect(result).toMatchObject({ kind: 'completed', truncated: true });
    expect(result.kind === 'completed' && result.output.length).toBe(64 * 1024);
  });

  it('returns sanitized output on success and fixed outcomes otherwise', async () => {
    expect((await run({ kind: 'completed', exitCode: 0, stdout: ok('\u001b[1mok\u001b[0m\n', { 'claude-opus-5-5': {} }), truncated: false })).result).toEqual({ kind: 'completed', output: 'ok\n', truncated: false, usedModels: ['claude-opus-5-5'] });
    expect((await run({ kind: 'completed', exitCode: 1, stdout: 'sk-leak', truncated: false })).result).toEqual({ kind: 'failed' });
    for (const stdout of ['sk-leak plain text', JSON.stringify({ type: 'result', is_error: true, result: 'sk-leak' })]) {
      expect((await run({ kind: 'completed', exitCode: 0, stdout, truncated: false })).result).toEqual({ kind: 'failed' });
    }
    expect((await run({ kind: 'completed', exitCode: 0, stdout: ok('x'), truncated: true })).result).toEqual({ kind: 'failed' });
    expect((await run({ kind: 'timeout' })).result).toEqual({ kind: 'timeout' });
    expect((await run({ kind: 'cancelled' })).result).toEqual({ kind: 'cancelled' });
    expect((await run({ kind: 'not-found' })).result).toEqual({ kind: 'not-installed' });
    expect((await run({ kind: 'spawn-failed' })).result).toEqual({ kind: 'spawn-failed' });
  });
});
