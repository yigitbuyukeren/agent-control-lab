import { describe, expect, it } from 'vitest';
import { bwrapSandbox, defaultProtectedPaths, detectSandbox, macSandbox, probeSandbox, resolveSandbox } from './sandbox.ts';

describe('sandbox detection', () => {
  it('reports Windows and unknown platforms as unavailable and never pretends', async () => {
    const win = await detectSandbox({ platform: 'win32' });
    expect(win.available).toBe(false);
    expect(win.available ? '' : win.reason).toContain('WSL2');
    expect((await detectSandbox({ platform: 'freebsd' })).available).toBe(false);
  });
  it('finds the platform tool only when it exists', async () => {
    expect((await detectSandbox({ platform: 'darwin', exists: () => Promise.resolve(false) })).available).toBe(false);
    expect((await detectSandbox({ platform: 'darwin', exists: () => Promise.resolve(true) })).available).toBe(true);
    expect((await detectSandbox({ platform: 'linux', pathEnv: '/a:/b', exists: (p) => Promise.resolve(p.endsWith('/b/bwrap')) })).available).toBe(true);
    expect((await detectSandbox({ platform: 'linux', pathEnv: '/a', exists: () => Promise.resolve(false) })).available).toBe(false);
  });
});

describe('sandbox wrapping', () => {
  const spec = { command: 'pnpm', args: ['test'], cwd: '/w x', tmp: '/t', protect: ['/h/.ssh'] };
  it('builds a deny-by-default macOS profile with write limited to cwd and tmp and no network', () => {
    const w = macSandbox.wrap(spec);
    expect(w.command).toBe('/usr/bin/sandbox-exec');
    const profile = w.args[1] ?? '';
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-read* (subpath "/h/.ssh"))');
    expect(profile).toContain('(subpath "/w x")');
    expect(w.args.slice(2)).toEqual(['pnpm', 'test']);
  });
  it('quotes hostile paths in the profile', () => {
    const profile = macSandbox.wrap({ ...spec, cwd: '/w") (allow network*) ("' }).args[1] ?? '';
    expect(profile).toContain('\\"');
    expect(profile.split('\n').filter((l) => l.startsWith('(allow network')).length).toBe(0);
  });
  it('builds a bubblewrap command that unshares the network and binds only cwd and tmp writable', () => {
    const w = bwrapSandbox.wrap(spec);
    expect(w.args).toEqual(expect.arrayContaining(['--unshare-net', '--ro-bind', '--die-with-parent']));
    expect(w.args.slice(-2)).toEqual(['pnpm', 'test']);
    expect(w.args.join(' ')).toContain('--tmpfs /h/.ssh');
  });
  it('lists the credential locations it protects', () => {
    expect(defaultProtectedPaths('/home/u')).toEqual(expect.arrayContaining(['/home/u/.ssh', '/home/u/.aws', '/home/u/.claude']));
  });
});

describe('sandboxed verification', () => {
  it.runIf(process.platform === 'darwin')('runs a real command with writes limited to the workspace and a private temp dir', async () => {
    const { mkdtempSync, realpathSync, existsSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runVerify } = await import('./verify.ts');
    const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl vw ')));
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl vo ')));
    writeFileSync(join(work, 'ok.js'), `require('fs').writeFileSync('inside.txt','x')`);
    writeFileSync(join(work, 'bad.js'), `require('fs').writeFileSync(${JSON.stringify(join(outside, 'leak.txt'))},'x')`);
    const sandbox = { name: macSandbox.name, wrap: (s: Parameters<typeof macSandbox.wrap>[0]) => macSandbox.wrap(s) };
    const good = await runVerify({ command: { command: process.execPath, args: ['ok.js'] }, cwd: work, timeoutMs: 20_000 }, { sandbox });
    expect(good.kind).toBe('completed');
    expect(existsSync(join(work, 'inside.txt'))).toBe(true);
    const bad = await runVerify({ command: { command: process.execPath, args: ['bad.js'] }, cwd: work, timeoutMs: 20_000 }, { sandbox });
    expect(bad.kind).toBe('rejected');
    expect(existsSync(join(outside, 'leak.txt'))).toBe(false);
  }, 60_000);
});

describe('sandbox probe', () => {
  it('fails closed when the wrapper does not actually restrict anything', async () => {
    const noop = { name: 'noop', wrap: (s: { command: string; args: readonly string[] }) => ({ command: s.command, args: s.args }) };
    const r = await probeSandbox(noop);
    expect(r.ok).toBe(false);
  });
  it('fails closed when the runner cannot run anything', async () => {
    const r = await probeSandbox(macSandbox, () => Promise.resolve({ kind: 'spawn-failed' }));
    expect(r.ok).toBe(false);
  });
  it.runIf(process.platform === 'darwin')('passes on macOS with the real sandbox-exec', async () => {
    expect(await resolveSandbox()).toMatchObject({ mode: 'sandboxed' });
  }, 60_000);
  it.runIf(process.platform === 'win32')('is unavailable on Windows', async () => {
    expect(await resolveSandbox()).toMatchObject({ mode: 'unavailable' });
  });
});
