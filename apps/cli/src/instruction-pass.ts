import { instructionContextFor, withProjectInstructions, type StepDefinition } from '@agent-control-lab/core';

/**
 * `--with-instructions`: adds the project's instruction text, per provider, to the model steps. Off by default so that
 * no project text is sent unless asked. Returns the steps and one line for the user saying what was passed.
 */
export async function applyInstructionContext(steps: StepDefinition[], enabled: boolean, cwd: string, nonce: string): Promise<{ steps: StepDefinition[]; line: string }> {
  if (!enabled) return { steps, line: '' };
  const providers = [...new Set(steps.flatMap((s) => (s.provider === 'local' ? [] : [s.provider])))];
  const contexts: Partial<Record<'claude' | 'codex', string>> = {};
  const lines: string[] = [];
  for (const provider of providers) {
    const ctx = await instructionContextFor(provider, cwd);
    if (ctx.text !== '') contexts[provider] = ctx.text;
    lines.push(`${provider}: ${ctx.included.length === 0 ? 'nothing to pass' : `${String(ctx.included.length)} file(s), ${String(ctx.text.length)} chars`}`);
  }
  return { steps: withProjectInstructions(steps, contexts, nonce), line: `project instructions (untrusted data, no personal or local files, secrets removed): ${lines.join('; ')}\n` };
}
