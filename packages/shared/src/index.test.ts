import { describe, expect, it } from 'vitest';
import { err, ok } from './index.ts';

describe('Result helpers', () => {
  it('wraps values and errors', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });
});
