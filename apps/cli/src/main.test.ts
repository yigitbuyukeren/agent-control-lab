import { describe, expect, it } from 'vitest';
import type { Exec } from '@agent-control-lab/core';
import { run } from './main.ts';

async function capture(argv: string[], exec?: Exec) {
  let out = '';
  let error = '';
  const code = await run(argv, { out: (t) => (out += t), error: (t) => (error += t) }, exec === undefined ? {} : { exec });
  return { code, out, error };
}

describe('cli', () => {
  it('prints the version', async () => {
    expect(await capture(['version'])).toMatchObject({ code: 0, out: '0.1.0\n' });
  });
  it('prints help by default', async () => {
    expect((await capture([])).out).toContain('Usage:');
  });
  it('prints info as JSON', async () => {
    const { out } = await capture(['info']);
    expect(JSON.parse(out)).toMatchObject({ name: 'agent-control-lab' });
  });
  it('fails on unknown commands', async () => {
    const r = await capture(['nope']);
    expect(r.code).toBe(2);
    expect(r.error).toContain('unknown command: nope');
  });
  it('lists providers using the injected exec only', async () => {
    const exec: Exec = (command) =>
      Promise.resolve(command === 'claude' ? { kind: 'ok', stdout: '2.1.4 (Claude Code)' } : { kind: 'not-found' });
    const r = await capture(['providers'], exec);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Claude Code  installed 2.1.4');
    expect(r.out).toContain('Codex        not installed');
  });
});
