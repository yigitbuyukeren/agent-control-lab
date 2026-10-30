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
