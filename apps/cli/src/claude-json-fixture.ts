import type { ProcessOutcome } from '@agent-control-lab/core';

/** What `claude -p --output-format json` prints for a successful run; extra fields are the kind that must never be kept. */
export function claudeJson(text: string, models: readonly string[] = ['claude-test-1']): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: 'SESSION-SECRET',
    total_cost_usd: 0.01,
    modelUsage: Object.fromEntries(models.map((m) => [m, { inputTokens: 1, outputTokens: 1 }])),
  });
}

/** Wraps a plain-text successful outcome the way the real Claude CLI would print it; other outcomes pass through. */
export function asClaude(outcome: ProcessOutcome): ProcessOutcome {
  return outcome.kind === 'completed' && outcome.exitCode === 0 && !outcome.truncated && !outcome.stdout.startsWith('{"type":"result"') ? { ...outcome, stdout: claudeJson(outcome.stdout) } : outcome;
}
