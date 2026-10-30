import { describe, expect, it } from 'vitest';
import { parseClaudeStatusLine } from './claude-quota.ts';

describe('parseClaudeStatusLine', () => {
  it('parses both windows and drops every other field', () => {
    const status = parseClaudeStatusLine(
      JSON.stringify({
        session_id: 'abc',
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: 1_800_000_000, email: 'me@example.com' },
          seven_day: { used_percentage: 40, resets_at: '2027-01-20T00:00:00Z' },
        },
      }),
    );
    expect(status).toEqual({
      state: 'ok',
      fiveHour: { windowMinutes: 300, usedPercent: 12, resetsAt: '2027-01-15T08:00:00.000Z' },
      sevenDay: { windowMinutes: 10080, usedPercent: 40, resetsAt: '2027-01-20T00:00:00.000Z' },
    });
    expect(JSON.stringify(status)).not.toMatch(/abc|example/);
  });

  it('keeps a window with only one valid field and clamps percentages', () => {
    expect(
      parseClaudeStatusLine('{"rate_limits":{"five_hour":{"used_percentage":150},"seven_day":{"resets_at":1800000000}}}'),
    ).toEqual({
      state: 'ok',
      fiveHour: { windowMinutes: 300, usedPercent: 100 },
      sevenDay: { windowMinutes: 10080, resetsAt: '2027-01-15T08:00:00.000Z' },
    });
  });

  it('is unknown for invalid, missing or unusable data', () => {
    for (const input of [
      '',
      'nope',
      '[]',
      '{}',
      '{"rate_limits":null}',
      '{"rate_limits":{"five_hour":{"used_percentage":"x","resets_at":"soon"}}}',
      '{"rate_limits":{"five_hour":{"used_percentage":null,"resets_at":-1}}}',
    ]) {
      expect(parseClaudeStatusLine(input)).toEqual({ state: 'unknown' });
    }
  });
});
