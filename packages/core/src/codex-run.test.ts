import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthStatus } from './auth.ts';
import {
  MAX_RUN_OUTPUT_BYTES,
  MAX_RUN_TIMEOUT_MS,
  MAX_TASK_CHARS,
  buildCodexExecArgs,
  codexRunEnv,
  planCodexRun,
  runCodex,
  validateTask,
  validateWorkingDir,
} from './codex-run.ts';
import { claudeRegistry, parseCodexModel, type ModelCapability } from './models.ts';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';
import { DEFAULT_REQUEST, resolveSelection, type Selection, type SelectionRequest } from './selection.ts';

const model = parseCodexModel({ model: 'gpt-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }) as ModelCapability;
const selectionFor = (r: Partial<SelectionRequest> = {}): Selection =>
  resolveSelection('codex', { ...DEFAULT_REQUEST, ...r }, { claude: claudeRegistry, codex: { state: 'ok', models: [model] } });
const auth = (over: Partial<AuthStatus>): AuthStatus => ({ id: 'codex', displayName: 'Codex', state: 'logged-in', method: 'subscription', ...over });

describe('buildCodexExecArgs', () => {
  it('is read-only, ephemeral, stdin-prompted and pins nothing for auto', () => {
    expect(buildCodexExecArgs(selectionFor())).toEqual(['exec', '-s', 'read-only', '--color', 'never', '--ephemeral', '-']);
  });
  it('pins an explicit model and effort only', () => {
    expect(buildCodexExecArgs(selectionFor({ model: 'gpt-a', effort: 'ultra' }))).toEqual([
      'exec', '-s', 'read-only', '--color', 'never', '--ephemeral', '-m', 'gpt-a', '-c', 'model_reasoning_effort=ultra', '-',
    ]);
  });
  it('never builds a write-capable, bypassing or alternative-provider flag', () => {
    const joined = buildCodexExecArgs(selectionFor({ model: 'gpt-a', effort: 'low' })).join(' ');
    for (const bad of ['danger', 'bypass', 'workspace-write', '--oss', 'full-auto', 'approve-for-me', 'add-dir', 'api']) {
      expect(joined).not.toContain(bad);
    }
  });
});

describe('codexRunEnv', () => {
  it('drops API-key variables (any case) and keeps the rest', () => {
    const env = codexRunEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-1', codex_api_key: 'sk-2', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('validateTask / validateWorkingDir', () => {
  it('rejects empty, oversized and NUL tasks', () => {
    expect(validateTask('do it')).toBe(true);
    for (const bad of ['', '   ', 'x'.repeat(MAX_TASK_CHARS + 1), 'a\0b']) expect(validateTask(bad)).toBe(false);
  });
  it('accepts only existing directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-wd-'));
    try {
      writeFileSync(join(dir, 'f'), 'x');
      expect(await validateWorkingDir(dir)).toBeDefined();
      expect(await validateWorkingDir(join(dir, 'f'))).toBeUndefined();
      expect(await validateWorkingDir(join(dir, 'missing'))).toBeUndefined();
      expect(await validateWorkingDir('')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planCodexRun', () => {
  const unverified = resolveSelection('codex', { ...DEFAULT_REQUEST, model: 'gpt-a' }, { claude: claudeRegistry, codex: { state: 'error', error: 'timed out' } });
  const plan = (over: Partial<Parameters<typeof planCodexRun>[0]> = {}) =>
    planCodexRun({ task: 'review the repo', auth: auth({}), selection: selectionFor(), git: 'repo', acceptUnverified: false, ...over });
  const reason = (over: Partial<Parameters<typeof planCodexRun>[0]>) => {
    const p = plan(over);
    return p.ok ? 'ok' : p.reason;
  };

  it('allows a subscription login inside a Git repo with a clean selection', () => {
    expect(plan()).toEqual({ ok: true, warnings: [] });
  });

  it('refuses every other login state without any fallback', () => {
    expect(reason({ auth: auth({ method: 'api-key' }) })).toBe('api-key-login');
    expect(reason({ auth: auth({ method: 'unknown' }) })).toBe('login-method-unknown');
    expect(reason({ auth: auth({ state: 'logged-out' }) })).toBe('not-logged-in');
    expect(reason({ auth: auth({ state: 'not-installed' }) })).toBe('codex-not-installed');
    expect(reason({ auth: auth({ state: 'unknown' }) })).toBe('login-state-unknown');
    expect(reason({ auth: auth({ state: 'error' }) })).toBe('login-state-unknown');
  });

  it('refuses outside a Git repo with distinct reasons, before anything else', () => {
    expect(reason({ git: 'not-a-repo' })).toBe('not-a-git-repo');
    expect(reason({ git: 'git-not-installed' })).toBe('git-not-installed');
    expect(reason({ git: 'check-failed' })).toBe('git-check-failed');
    expect(reason({ git: 'not-a-repo', auth: auth({ state: 'logged-out' }) })).toBe('not-a-git-repo');
    expect(reason({ task: '', git: 'not-a-repo' })).toBe('task-invalid');
  });

  it('refuses blocked selections with their issues, even with acceptUnverified', () => {
    for (const acceptUnverified of [false, true]) {
      expect(plan({ selection: selectionFor({ model: 'nope' }), acceptUnverified })).toMatchObject({ ok: false, reason: 'selection-blocked', issues: [{ code: 'model-not-listed' }] });
      expect(plan({ selection: selectionFor({ mode: 'ultracode' }), acceptUnverified })).toMatchObject({ reason: 'selection-blocked', issues: [{ code: 'mode-unsupported' }] });
      expect(plan({ selection: selectionFor({ model: 'gpt-a', effort: 'max' }), acceptUnverified })).toMatchObject({ reason: 'selection-blocked' });
    }
  });

  it('needs explicit acceptance for unverified selections and carries them as warnings', () => {
    expect(plan({ selection: unverified })).toMatchObject({ ok: false, reason: 'unverified-selection', issues: [{ code: 'model-discovery-failed' }] });
    expect(plan({ selection: unverified, acceptUnverified: true })).toMatchObject({ ok: true, warnings: [{ code: 'model-discovery-failed' }] });
  });

  it('does not require acceptance when nothing is unverified', () => {
    expect(plan({ selection: selectionFor({ model: 'gpt-a', effort: 'low' }), acceptUnverified: false })).toMatchObject({ ok: true });
  });
});

describe('runCodex (mock runner)', () => {
  const run = async (outcome: ProcessOutcome, over: Partial<{ timeoutMs: number }> = {}) => {
    const specs: ProcessSpec[] = [];
    const result = await runCodex(
      { task: 'hello', cwd: '/work', selection: selectionFor(), timeoutMs: over.timeoutMs ?? 1000 },
      { runner: (s) => { specs.push(s); return Promise.resolve(outcome); }, env: { PATH: '/bin', OPENAI_API_KEY: 'sk-x' } },
    );
    return { result, spec: specs[0] as ProcessSpec };
  };

  it('starts codex with an explicit cwd, prompt on stdin, bounded output and no API key', async () => {
    const { spec } = await run({ kind: 'completed', exitCode: 0, stdout: 'x', truncated: false });
    expect(spec).toMatchObject({ command: 'codex', cwd: '/work', input: 'hello', maxOutputBytes: MAX_RUN_OUTPUT_BYTES, timeoutMs: 1000 });
    expect(spec.env).toEqual({ PATH: '/bin' });
  });

  it('returns sanitized output on success and nothing on failure', async () => {
    const ok = await run({ kind: 'completed', exitCode: 0, stdout: '\u001b[31mred\u001b[0m\u0007 text\n', truncated: true });
    expect(ok.result).toEqual({ kind: 'completed', output: 'red text\n', truncated: true });
    const failed = await run({ kind: 'completed', exitCode: 1, stdout: 'secret sk-123', truncated: false });
    expect(failed.result).toEqual({ kind: 'failed' });
  });

  it('maps timeout, cancel, missing binary and spawn failure; clamps the timeout', async () => {
    expect((await run({ kind: 'timeout' })).result).toEqual({ kind: 'timeout' });
    expect((await run({ kind: 'cancelled' })).result).toEqual({ kind: 'cancelled' });
    expect((await run({ kind: 'not-found' })).result).toEqual({ kind: 'not-installed' });
    expect((await run({ kind: 'spawn-failed' })).result).toEqual({ kind: 'spawn-failed' });
    expect((await run({ kind: 'timeout' }, { timeoutMs: 10 ** 12 })).spec.timeoutMs).toBe(MAX_RUN_TIMEOUT_MS);
  });
});
