import { describe, expect, it, vi } from 'vitest';
import { resolveWindowsExecutable } from './providers.ts';
import {
  claudeCodeAdapter,
  codexAdapter,
  createExec,
  detectProvider,
  detectProviders,
  parseVersion,
  type Exec,
} from './providers.ts';

describe('parseVersion', () => {
  it('extracts semver from typical outputs', () => {
    expect(parseVersion('2.1.4 (Claude Code)\n')).toBe('2.1.4');
    expect(parseVersion('codex-cli 0.46.0-beta.1')).toBe('0.46.0-beta.1');
  });
  it('returns undefined when absent', () => {
    expect(parseVersion('hello')).toBeUndefined();
  });
});

describe('detectProvider', () => {
  it('reports version and calls only the version args', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue({ kind: 'ok', stdout: '2.1.4 (Claude Code)' });
    const status = await detectProvider(claudeCodeAdapter, exec, 1000);
    expect(status).toEqual({
      id: 'claude-code',
      displayName: 'Claude Code',
      installed: true,
      version: '2.1.4',
    });
    expect(exec).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 1000 });
  });

  it('is installed without version when output is unparseable', async () => {
    const exec: Exec = () => Promise.resolve({ kind: 'ok', stdout: 'weird' });
    expect(await detectProvider(codexAdapter, exec)).toMatchObject({ installed: true });
  });

  it('handles not-found, timeout, failure and thrown errors', async () => {
    const run = (r: Awaited<ReturnType<Exec>>) => detectProvider(codexAdapter, () => Promise.resolve(r), undefined);
    expect(await run({ kind: 'not-found' })).toEqual({
      id: 'codex',
      displayName: 'Codex',
      installed: false,
    });
    expect(await run({ kind: 'timeout' })).toMatchObject({ installed: false, error: 'timed out after 5000 ms' });
    expect(await run({ kind: 'failed', detail: 'boom' })).toMatchObject({ installed: false, error: 'boom' });
    const thrown = await detectProvider(codexAdapter, () => Promise.reject(new Error('spawn broke')));
    expect(thrown).toMatchObject({ installed: false, error: 'spawn broke' });
  });
});

describe('detectProviders', () => {
  it('checks every adapter independently', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(command === 'claude' ? { kind: 'ok', stdout: '1.0.0' } : { kind: 'not-found' });
    const statuses = await detectProviders([claudeCodeAdapter, codexAdapter], exec);
    expect(statuses.map((s) => [s.id, s.installed])).toEqual([
      ['claude-code', true],
      ['codex', false],
    ]);
  });
});

describe('resolveWindowsExecutable', () => {
  const exists = (known: string[]) => (p: string) => known.includes(p);

  it('searches PATH in order using PATHEXT, with case-insensitive env keys', () => {
    const env = { Path: 'C:\\a;"C:\\b c"', PathExt: '.EXE;.CMD' };
    expect(resolveWindowsExecutable('claude', env, exists(['C:\\b c\\claude.CMD', 'C:\\a\\claude.CMD']))).toBe(
      'C:\\a\\claude.CMD',
    );
    expect(resolveWindowsExecutable('claude', env, exists(['C:\\b c\\claude.EXE']))).toBe('C:\\b c\\claude.EXE');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveWindowsExecutable('claude', { PATH: 'C:\\a' }, exists([]))).toBeUndefined();
  });
});

describe('createExec on win32', () => {
  it('reports not-found without spawning when the command is not on PATH', async () => {
    const exec = createExec({ platform: 'win32', env: { PATH: 'C:\\a' }, exists: () => false });
    expect(await exec('claude', ['--version'], { timeoutMs: 1000 })).toEqual({ kind: 'not-found' });
  });
});
