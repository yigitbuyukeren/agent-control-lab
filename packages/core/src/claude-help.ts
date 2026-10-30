import { asEffortLevel } from './models.ts';

/**
 * What `claude --help` itself says about model and effort. This is the installed CLI's own
 * vocabulary: which effort names it accepts and which model aliases it gives as examples. It
 * is not a list of models, says nothing about this account's access, and nothing per model.
 */
export interface ClaudeHelpFacts {
  /** Alias examples quoted in the `--model` text; `undefined` when none could be read. */
  readonly modelAliases: readonly string[] | undefined;
  /** Effort names in the parenthesised list of the `--effort` text; `undefined` when not readable. */
  readonly efforts: readonly string[] | undefined;
}

const ALIAS = /^[a-z][a-z0-9-]{0,30}$/;

/** The text of one option: its first line plus the indented lines that continue it. */
function optionText(help: string, flag: string): string | undefined {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^ {1,4}(?:-\\w, )?${flag}(?:\\s|$)`).test(line));
  if (start === -1) return undefined;
  const parts = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (/^ {1,4}-/.test(line) || !/^\s{6,}\S/.test(line)) break;
    parts.push(line);
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

export function parseClaudeHelp(help: string): ClaudeHelpFacts {
  const model = optionText(help, '--model');
  const effort = optionText(help, '--effort');
  const aliases = model === undefined ? [] : [...model.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').filter((a) => ALIAS.test(a));
  const list = effort === undefined ? undefined : /\(([a-z]+(?:\s*,\s*[a-z]+)+)\)/.exec(effort)?.[1];
  const efforts = list === undefined ? [] : list.split(',').flatMap((name) => {
    const level = asEffortLevel(name.trim());
    return level === undefined ? [] : [level];
  });
  return {
    modelAliases: aliases.length === 0 ? undefined : [...new Set(aliases)],
    efforts: efforts.length === 0 ? undefined : [...new Set(efforts)],
  };
}
