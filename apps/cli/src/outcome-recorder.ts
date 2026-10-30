import {
  estimateTaskSize,
  classifyTask,
  recordsFromRun,
  selectionSteps,
  type OutcomeStore,
  type RunFacts,
  type StepRequests,
  type WorkflowName,
  type WorkflowResult,
} from '@agent-control-lab/core';

/**
 * Stores what a finished real run objectively showed (see `OutcomeRecord`). Never throws: a store problem is
 * reported on one line and the run result is unaffected. Returns the line to print, or '' when nothing applies.
 */
export async function recordRun(
  store: OutcomeStore | undefined,
  enabled: boolean,
  workflow: WorkflowName,
  task: string,
  requests: StepRequests,
  result: WorkflowResult,
  now: Date,
): Promise<string> {
  if (store === undefined) return '';
  if (!enabled) return 'outcomes: not recorded (--no-record)\n';
  const steps: RunFacts['steps'] = Object.fromEntries(
    selectionSteps(workflow).flatMap(({ step, provider }) => {
      const request = requests[step]?.request;
      return request === undefined ? [] : [[step, { provider, model: request.model, effort: request.effort }]];
    }),
  );
  const records = recordsFromRun(result, { day: now.toISOString().slice(0, 10), task: classifyTask(task), size: estimateTaskSize(task), steps });
  if (records.length === 0) return '';
  try {
    await store.append(records);
  } catch {
    return 'outcomes: could not be recorded locally\n';
  }
  return `outcomes: ${String(records.length)} step result(s) recorded locally (no task text, output, paths or session ids; \`outcomes clear\` deletes them, --no-record skips)\n`;
}
