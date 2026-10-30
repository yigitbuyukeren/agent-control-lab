import { describe, expect, it } from 'vitest';
import type { ProcessOutcome, ProcessSpec } from './process-runner.ts';
import { VERIFY_COMMANDS, parseVerifyCommand, runVerify } from './verify.ts';

describe('parseVerifyCommand', () => {
  it('accepts plain words starting with an allowed tool', () => {
    expect(parseVerifyCommand('pnpm test')).toEqual({ command: 'pnpm', args: ['test'] });
    expect(parseVerifyCommand('  cargo   test --workspace ')).toEqual({ command: 'cargo', args: ['test', '--workspace'] });
    expect(parseVerifyCommand('pnpm --filter @scope/pkg test')).toEqual({ command: 'pnpm', args: ['--filter', '@scope/pkg', 'test'] });
  });

  it('rejects shell syntax, quoting and expansion instead of interpreting it', () => {
    for (const text of ['pnpm test; rm -rf /', 'pnpm test && curl x', 'pnpm test | tee out', 'pnpm test > out', 'pnpm "test"', "pnpm 'a b'", 'pnpm $HOME', 'pnpm `id`', 'pnpm test\nrm x', 'pnpm ~/x', 'pnpm *']) {
      expect(typeof parseVerifyCommand(text)).toBe('string');
    }
  });

  it('rejects empty, long and non-allowlisted commands', () => {
    for (const text of ['', '   ', 'x'.repeat(201), 'rm -rf x', 'sh -c x', 'curl http://x', './pnpm test', '/usr/bin/node x']) {
      expect(typeof parseVerifyCommand(text)).toBe('string');
    }
    expect(VERIFY_COMMANDS).not.toEqual(expect.arrayContaining(['sh', 'bash', 'curl', 'rm', 'npx']));
  });
});

describe('runVerify', () => {
  const request = { command: { command: 'pnpm', args: ['test'] }, cwd: '/ws', timeoutMs: 1234 };
  const run = async (outcome: ProcessOutcome) => {
    const specs: ProcessSpec[] = [];
    const result = await runVerify(request, {
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk', OPENAI_API_KEY: 'sk', HTTPS_PROXY: 'p', GITHUB_TOKEN: 't' },
      runner: (spec) => {
        specs.push(spec);
        return Promise.resolve(outcome);
      },
    });
    return { result, spec: specs[0] as ProcessSpec };
  };

  it('runs without a shell in the workspace with a cleaned environment', async () => {
    const { spec } = await run({ kind: 'completed', exitCode: 0, stdout: 'ok\n', truncated: false });
    expect(spec).toMatchObject({ command: 'pnpm', args: ['test'], cwd: '/ws', timeoutMs: 1234 });
    expect(spec.env).toEqual({ PATH: '/bin' });
  });

  it('reports a pass, a failure (rejected, with the report) and an output tail that is cleaned and short', async () => {
    const pass = await run({ kind: 'completed', exitCode: 0, stdout: '\u001b[31mall green\u001b[0m\n', truncated: false });
    expect(pass.result).toMatchObject({ kind: 'completed' });
    expect(pass.result.kind === 'completed' && pass.result.output).toContain('result: passed');
    expect(pass.result.kind === 'completed' && pass.result.output).not.toContain('\u001b');
    const fail = await run({ kind: 'completed', exitCode: 3, stdout: `${'x'.repeat(5000)}END`, truncated: false });
    expect(fail.result).toMatchObject({ kind: 'rejected', error: 'verification failed (exit 3)' });
    const out = fail.result.kind === 'rejected' ? (fail.result.output ?? '') : '';
    expect(out).toContain('failed (exit 3)');
    expect(out).toContain('END');
    expect(out.length).toBeLessThan(2300);
  });

  it('maps timeout, cancel, spawn problems and a missing tool', async () => {
    expect((await run({ kind: 'timeout' })).result).toEqual({ kind: 'timeout' });
    expect((await run({ kind: 'cancelled' })).result).toEqual({ kind: 'cancelled' });
    expect((await run({ kind: 'spawn-failed' })).result).toEqual({ kind: 'spawn-failed' });
    expect((await run({ kind: 'not-found' })).result).toMatchObject({ kind: 'rejected', error: 'verification command not found' });
  });
});
