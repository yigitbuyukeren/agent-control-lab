import { buildInstructionContext, crossProviderConflicts, resolveInstructions, type ResolvedInstructions } from '@agent-control-lab/core';
import { resolve } from 'node:path';
import { safeText } from './workspaces.ts';

export const INSTRUCTIONS_USAGE = 'usage: agent-control-lab instructions --cwd <dir> [--provider claude|codex|both] [--context] [--json]';

export interface InstructionsArgs {
  readonly cwd: string;
  readonly provider: 'claude' | 'codex' | 'both';
  readonly context: boolean;
  readonly json: boolean;
}

export function parseInstructionsArgs(args: readonly string[]): InstructionsArgs | string {
  let cwd: string | undefined;
  let provider: InstructionsArgs['provider'] = 'both';
  let context = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--context') context = true;
    else if (arg === '--cwd' || arg === '--provider') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value\n${INSTRUCTIONS_USAGE}`;
      i += 1;
      if (arg === '--cwd') cwd = value;
      else if (value === 'claude' || value === 'codex' || value === 'both') provider = value;
      else return `--provider must be claude, codex or both\n${INSTRUCTIONS_USAGE}`;
    } else return `unknown option: ${String(arg)}\n${INSTRUCTIONS_USAGE}`;
  }
  if (cwd === undefined) return `--cwd is required\n${INSTRUCTIONS_USAGE}`;
  return { cwd: resolve(cwd), provider, context, json };
}

function format(r: ResolvedInstructions): string {
  let out = `${r.provider}: ${r.entries.length === 0 ? 'no instruction files' : `${String(r.entries.length)} file(s)`}\n`;
  for (const e of r.entries) {
    out += `  [${e.status}] ${e.scope}/${e.kind}  ${safeText(e.path)}  ${String(e.bytes)} B${e.sha256 === undefined ? '' : `  sha256:${e.sha256.slice(0, 12)}`}\n    ${e.reason}\n`;
    for (const f of e.flags) out += `    ! ${f}\n`;
  }
  for (const c of r.conflicts) out += `  conflict (${c.kind}): ${c.detail}\n`;
  for (const w of r.warnings) out += `  warning: ${w}\n`;
  return out;
}

/** Read-only: shows which instruction files each provider would use; never changes a file. */
export async function runInstructionsCommand(args: InstructionsArgs, io: { out(t: string): void; error(t: string): void }): Promise<number> {
  const claude = args.provider === 'codex' ? undefined : await resolveInstructions('claude', args.cwd);
  const codex = args.provider === 'claude' ? undefined : await resolveInstructions('codex', args.cwd);
  const cross = claude !== undefined && codex !== undefined ? crossProviderConflicts(claude, codex) : [];
  const ctx = args.context && claude !== undefined ? await buildInstructionContext(claude) : undefined;
  if (args.json) {
    io.out(`${JSON.stringify({ claude, codex, crossProviderConflicts: cross, ...(ctx === undefined ? {} : { context: ctx }) }, null, 2)}\n`);
    return 0;
  }
  let out = '';
  for (const r of [claude, codex]) if (r !== undefined) out += format(r);
  for (const c of cross) out += `conflict (${c.kind}): ${c.detail}\n`;
  if (ctx !== undefined) out += `\nexportable context (${String(ctx.text.length)} chars, untrusted data):\n${ctx.text}\n`;
  io.out(out);
  return 0;
}
