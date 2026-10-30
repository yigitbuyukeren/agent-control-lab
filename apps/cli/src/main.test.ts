import { describe, expect, it } from 'vitest';
import { run } from './main.ts';

function capture(argv: string[]) {
  let out = '';
  let error = '';
  const code = run(argv, { out: (t) => (out += t), error: (t) => (error += t) });
  return { code, out, error };
}

describe('cli', () => {
  it('prints the version', () => {
    expect(capture(['version'])).toMatchObject({ code: 0, out: '0.1.0\n' });
  });
  it('prints help by default', () => {
    expect(capture([]).out).toContain('Usage:');
  });
  it('prints info as JSON', () => {
    const { out } = capture(['info']);
    expect(JSON.parse(out)).toMatchObject({ name: 'agent-control-lab' });
  });
  it('fails on unknown commands', () => {
    const r = capture(['nope']);
    expect(r.code).toBe(2);
    expect(r.error).toContain('unknown command: nope');
  });
});
