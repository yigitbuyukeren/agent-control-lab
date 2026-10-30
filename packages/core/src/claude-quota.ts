import type { QuotaWindow } from './quota.ts';

export interface ClaudeQuotaStatus {
  /** `unknown` when the input is not valid JSON or has no usable rate_limits. */
  readonly state: 'ok' | 'unknown';
  readonly fiveHour?: QuotaWindow;
  readonly sevenDay?: QuotaWindow;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toIso(value: unknown): string | undefined {
  let date: Date | undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    date = new Date(value * 1000);
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    date = new Date(value);
  }
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseWindow(value: unknown, windowMinutes: number): QuotaWindow | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const used = record['used_percentage'];
  const resetsAt = toIso(record['resets_at']);
  const hasPercent = typeof used === 'number' && Number.isFinite(used);
  if (!hasPercent && resetsAt === undefined) return undefined;
  return {
    windowMinutes,
    ...(hasPercent ? { usedPercent: Math.min(100, Math.max(0, used)) } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * Reads `rate_limits.five_hour` / `seven_day` from Claude Code's statusLine JSON.
 * Only usage percentage and reset time are kept; everything else is dropped.
 */
export function parseClaudeStatusLine(text: string): ClaudeQuotaStatus {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: 'unknown' };
  }
  const limits = asRecord(asRecord(data)?.['rate_limits']);
  if (limits === undefined) return { state: 'unknown' };
  const fiveHour = parseWindow(limits['five_hour'], 300);
  const sevenDay = parseWindow(limits['seven_day'], 10080);
  if (fiveHour === undefined && sevenDay === undefined) return { state: 'unknown' };
  return {
    state: 'ok',
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
  };
}
