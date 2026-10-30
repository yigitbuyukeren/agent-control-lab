import { describe, expect, it } from 'vitest';
import { maskSecrets } from './gui-secrets.ts';
import { parseRunOutput, RunManager, type GuiRun } from './gui-run.ts';

describe('maskSecrets', () => {
  it('masks keys, tokens, bearer headers, key=value pairs, URL credentials and the GUI token', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwx', 'gh ghp_abcdefghijklmnopqrstuvwxyz0123', 'aws AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abcdefghijklmnop1234', 'ANTHROPIC_API_KEY=supersecretvalue', 'password: "hunter22222"',
      'https://user:pa55word@example.com/x', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij', 'own guitoken-123456',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----',
    ].join('\n');
    const out = maskSecrets(text, ['guitoken-123456']);
    for (const leaked of ['abcdefghijklmnopqrstuvwx', 'ghp_', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnop1234', 'supersecretvalue', 'hunter22222', 'pa55word', 'eyJhbGci', 'guitoken-123456', 'MIIEvQ']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[maskelendi]');
  });
  it('leaves ordinary text alone', () => {
    const text = 'step 1/2 plan [claude] completed (3.2s)\nuse a token bucket for rate limits';
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('parseRunOutput', () => {
  it('splits step sections, extracts the reported model and the summary', () => {
    const out = 'Everything under a step heading is model output.\n\n== step 1/2 plan [claude] completed (3.2s) ==\nPLAN: do it\nmodel used (reported by the response): claude-x\n\n== step 2/2 review [codex] completed (1.0s) ==\nVERDICT: ok\n\nsummary: plan-review completed\n  plan claude completed 3.2s\n';
    const r = parseRunOutput(out);
    expect(r.sections).toEqual([
      { id: 'plan', provider: 'claude', status: 'completed', text: 'PLAN: do it', usedModel: 'claude-x' },
      { id: 'review', provider: 'codex', status: 'completed', text: 'VERDICT: ok' },
    ]);
    expect(r.summary).toBe('plan-review completed');
  });
});

describe('RunManager', () => {
  const mk = (run: GuiRun) => new RunManager({ run, now: () => 1000, hide: ['hidden-token-1'] });
  const steps = [{ id: 'plan', provider: 'claude' }, { id: 'review', provider: 'codex' }];

  it('tracks step progress from the CLI progress lines and masks everything', async () => {
    const m = mk((_a, io) => {
      io.error('step 1/2 plan [claude] running\nstep 1/2 plan [claude] completed (1.5s)\nleak sk-abcdefghijklmnopqrstuv hidden-token-1\nstep 2/2 review');
      io.error(' [codex] running\n');
      io.out('== step 1/2 plan [claude] completed (1.5s) ==\nout sk-abcdefghijklmnopqrstuv\n\nsummary: plan-review completed\n');
      return Promise.resolve(0);
    });
    m.start(['x'], steps, 5000);
    await m.shutdown();
    const snap = m.snapshot();
    expect(snap?.status).toBe('completed');
    expect(snap?.steps.map((s) => s.status)).toEqual(['completed', 'running']);
    expect(snap?.steps[0]?.seconds).toBe(1.5);
    expect(JSON.stringify(snap)).not.toMatch(/sk-abcdefghijklmnopqrstuv|hidden-token-1/);
    expect(m.active).toBe(false);
  });
  it('cancels through the signal and reports cancelled; a second start while active is refused', async () => {
    const m = mk((_a, _io, signal) => new Promise((resolve) => { signal?.addEventListener('abort', () => { resolve(130); }); }));
    m.start(['x'], steps, 5000);
    expect(m.active).toBe(true);
    expect(() => { m.start(['y'], steps, 5000); }).toThrow();
    expect(m.cancel()).toBe(true);
    expect(m.snapshot()?.status).toBe('cancelling');
    await m.shutdown();
    expect(m.snapshot()?.status).toBe('cancelled');
  });
  it('turns the watchdog into a timeout', async () => {
    const m = mk((_a, _io, signal) => new Promise((resolve) => { signal?.addEventListener('abort', () => { resolve(130); }); }));
    m.start(['x'], steps, 20);
    await new Promise((r) => setTimeout(r, 80));
    await m.shutdown();
    expect(m.snapshot()?.status).toBe('timeout');
  });
  it('shows a CLI refusal, and a crash as a generic failure', async () => {
    const refused = mk((_a, io) => { io.error('orchestrate refused: no step was started\n  step 1 [claude]: would refuse: proxy variables\n'); return Promise.resolve(1); });
    refused.start(['x'], steps, 5000);
    await refused.shutdown();
    expect(refused.snapshot()?.status).toBe('refused');
    expect(refused.snapshot()?.refusal?.join('\n')).toContain('proxy variables');
    expect(refused.snapshot()?.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
    const crashed = mk(() => Promise.reject(new Error('boom sk-abcdefghijklmnopqrstuv')));
    crashed.start(['x'], steps, 5000);
    await crashed.shutdown();
    expect(crashed.snapshot()?.status).toBe('failed');
    expect(JSON.stringify(crashed.snapshot())).not.toContain('boom');
  });
});

describe('RunManager log overflow', () => {
  const steps = [{ id: 'plan', provider: 'claude' }, { id: 'review', provider: 'codex' }];
  const hold = () => {
    const held: { io?: { error: (t: string) => void }; settle?: (code: number) => void } = {};
    const run: GuiRun = (_a, io, signal) => new Promise((resolve) => {
      held.io = io;
      held.settle = resolve;
      signal?.addEventListener('abort', () => { resolve(130); });
    });
    return { held, run };
  };
  const lines = (from: number, n: number): string => Array.from({ length: n }, (_, i) => `line ${String(from + i)}\n`).join('');

  it('keeps the cursor moving past the 400 line limit with bounded memory, and says what was skipped', async () => {
    const { held, run } = hold();
    const m = new RunManager({ run, now: () => 1, hide: [] });
    m.start(['x'], steps, 5000);
    held.io?.error(lines(0, 500));
    const first = m.snapshot(0);
    expect(first?.lines).toHaveLength(400);
    expect(first?.lines[0]).toBe('line 100');
    expect(first?.next).toBe(500);
    expect(first?.skipped).toBe(100);
    expect(m.snapshot(500)?.lines).toEqual([]);
    held.io?.error(lines(500, 10));
    const more = m.snapshot(500);
    expect(more?.lines).toHaveLength(10);
    expect(more?.lines[0]).toBe('line 500');
    expect(more?.next).toBe(510);
    expect(more?.skipped).toBeUndefined();
    // a client that fell far behind jumps forward instead of sticking
    held.io?.error(lines(510, 1000));
    const behind = m.snapshot(510);
    expect(behind?.skipped).toBe(1510 - 400 - 510);
    expect(behind?.next).toBe(1510);
    expect(behind?.lines).toHaveLength(400);
    // junk cursors cannot read outside the buffer
    expect(m.snapshot(1e9)?.lines).toEqual([]);
    expect(m.snapshot(-5)?.next).toBe(1510);
    await m.shutdown();
  });

  it('still cancels and finishes cleanly after an overflow', async () => {
    const { held, run } = hold();
    const m = new RunManager({ run, now: () => 1, hide: [] });
    m.start(['x'], steps, 5000);
    held.io?.error(lines(0, 900));
    expect(m.cancel()).toBe(true);
    await m.shutdown();
    const snap = m.snapshot(0);
    expect(snap?.status).toBe('cancelled');
    expect(snap?.lines.length).toBeLessThanOrEqual(400);
    expect(snap?.next).toBe(900);
  });

  it('counts the internal-error line in the same stream', async () => {
    const m = new RunManager({ run: () => Promise.reject(new Error('x')), now: () => 1, hide: [] });
    m.start(['x'], steps, 5000);
    await m.shutdown();
    expect(m.snapshot(0)?.lines).toEqual(['internal error: the run stopped unexpectedly']);
    expect(m.snapshot(1)?.next).toBe(1);
  });
});
