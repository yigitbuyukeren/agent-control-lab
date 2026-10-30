import { describe, expect, it } from 'vitest';
import { getInfo, parseCommand } from './index.ts';

describe('parseCommand', () => {
  it('defaults to help', () => {
    expect(parseCommand([])).toEqual({ ok: true, value: 'help' });
  });
  it('recognises commands and flags', () => {
    expect(parseCommand(['--version'])).toEqual({ ok: true, value: 'version' });
    expect(parseCommand(['info'])).toEqual({ ok: true, value: 'info' });
    expect(parseCommand(['auth-status'])).toEqual({ ok: true, value: 'auth-status' });
    expect(parseCommand(['providers'])).toEqual({ ok: true, value: 'providers' });
  });
  it('rejects unknown input', () => {
    expect(parseCommand(['nope'])).toEqual({ ok: false, error: 'unknown command: nope' });
  });
});

describe('getInfo', () => {
  it('includes runtime details', () => {
    expect(getInfo({ node: 'v24', platform: 'linux' })).toMatchObject({
      name: 'agent-control-lab',
      node: 'v24',
    });
  });
});
