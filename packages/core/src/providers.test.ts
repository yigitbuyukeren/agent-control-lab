import { describe, expect, it, vi } from 'vitest';
import { quoteForCmd, resolveLaunch, resolveWindowsExecutable } from './providers.ts';
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
      state: 'installed',
      version: '2.1.4',
    });
    expect(exec).toHaveBeenCalledWith('claude', ['--version'], { timeoutMs: 1000 });
  });

  it('is installed without version when output is unparseable', async () => {
    const exec: Exec = () => Promise.resolve({ kind: 'ok', stdout: 'weird' });
    expect(await detectProvider(codexAdapter, exec)).toMatchObject({ state: 'installed' });
  });

  it('handles not-found, timeout, failure and thrown errors', async () => {
    const run = (r: Awaited<ReturnType<Exec>>) => detectProvider(codexAdapter, () => Promise.resolve(r), undefined);
    expect(await run({ kind: 'not-found' })).toEqual({
      id: 'codex',
      displayName: 'Codex',
      state: 'not-found',
    });
    expect(await run({ kind: 'timeout' })).toMatchObject({ state: 'error', error: 'timed out after 5000 ms' });
    expect(await run({ kind: 'failed', detail: 'boom' })).toMatchObject({ state: 'error', error: 'boom' });
    const thrown = await detectProvider(codexAdapter, () => Promise.reject(new Error('spawn broke')));
    expect(thrown).toMatchObject({ state: 'error', error: 'spawn broke' });
  });
});

describe('detectProviders', () => {
  it('checks every adapter independently', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(command === 'claude' ? { kind: 'ok', stdout: '1.0.0' } : { kind: 'not-found' });
    const statuses = await detectProviders([claudeCodeAdapter, codexAdapter], exec);
    expect(statuses.map((s) => [s.id, s.state])).toEqual([
      ['claude-code', 'installed'],
      ['codex', 'not-found'],
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

describe('cmd.exe shim launch', () => {
  const launch = (args: string[]) =>
    resolveLaunch('claude', args, { platform: 'win32', env: { PATH: 'C:\\bin', ComSpec: 'cmd.exe' }, exists: (p) => p === 'C:\\bin\\claude.CMD' });

  it('keeps empty and spaced arguments as quoted tokens', () => {
    expect(launch(['-p', '--tools', '', '--note', 'a b'])).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\bin\\claude.CMD" -p --tools "" --note "a b""'],
      verbatim: true,
    });
  });

  it('refuses arguments cmd.exe would interpret', () => {
    for (const bad of ['a&b', 'a|b', 'a>b', '%PATH%', 'a^b', 'x"y', 'a!b']) {
      expect(() => quoteForCmd(bad)).toThrow(TypeError);
      expect(() => launch([bad])).toThrow(TypeError);
    }
  });

  it('does not touch non-shim executables or POSIX launches', () => {
    expect(resolveLaunch('claude', ['--tools', ''], { platform: 'linux', env: {} })).toEqual({ file: 'claude', args: ['--tools', ''], verbatim: false });
    expect(resolveLaunch('claude', ['--tools', ''], { platform: 'win32', env: { PATH: 'C:\\bin' }, exists: (p) => p === 'C:\\bin\\claude.EXE' })).toEqual({
      file: 'C:\\bin\\claude.EXE',
      args: ['--tools', ''],
      verbatim: false,
    });
  });
});
