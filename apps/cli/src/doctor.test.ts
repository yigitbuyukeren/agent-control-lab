import { describe, expect, it } from 'vitest';
import type { Exec } from '@agent-control-lab/core';
import { formatDoctor, runDoctor } from './doctor.ts';

const exec = (table: Record<string, string>): Exec => (command, args) => {
  const key = `${command} ${args.join(' ')}`;
  const v = table[key];
  if (v === undefined) return Promise.resolve({ kind: 'not-found' });
  return Promise.resolve({ kind: 'ok', stdout: v });
};

describe('doctor', () => {
  const sandbox = { mode: 'unavailable', reason: 'test' } as const;
  it('reports a missing agent as a warning with install help, and none installed as a failure', async () => {
    const checks = await runDoctor({ exec: exec({ 'git --version': 'git version 2.50' }), sandbox, cacheDir: undefined });
    expect(checks.find((c) => c.id === 'git')?.status).toBe('ok');
    expect(checks.find((c) => c.id === 'claude code')?.status ?? checks.find((c) => c.message.includes('Claude'))?.status).toBe('warn');
    expect(checks.find((c) => c.id === 'agents')?.status).toBe('fail');
    expect(formatDoctor(checks)).toContain('->');
  });
  it('fails on an old Node and on missing git, and says no sandbox plainly', async () => {
    const checks = await runDoctor({ exec: exec({}), sandbox, nodeVersion: 'v20.1.0', cacheDir: undefined });
    expect(checks.find((c) => c.id === 'node')?.status).toBe('fail');
    expect(checks.find((c) => c.id === 'git')?.status).toBe('fail');
    expect(checks.find((c) => c.id === 'sandbox')?.message).toContain('no working OS sandbox');
    expect(checks.find((c) => c.id === 'data')?.status).toBe('warn');
  });
});
