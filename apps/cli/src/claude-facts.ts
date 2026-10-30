import {
  claudeCodeAdapter,
  claudeRegistry,
  claudeRunEnv,
  createExec,
  detectAuth,
  detectProvider,
  parseClaudeHelp,
  type Exec,
} from '@agent-control-lab/core';

/**
 * What can be established about Claude models without calling one, each with its source.
 * Anything no local command can prove is printed as UNKNOWN, never filled in from the static list.
 */
export async function describeClaudeFacts(deps: { exec?: Exec; env?: Readonly<Record<string, string | undefined>> }): Promise<string> {
  const exec = deps.exec ?? createExec({ env: claudeRunEnv(deps.env ?? process.env) });
  const [provider, auth, help] = await Promise.all([detectProvider(claudeCodeAdapter, exec), detectAuth(claudeCodeAdapter, exec), exec('claude', ['--help'], { timeoutMs: 5000 })]);
  const facts = help.kind === 'ok' ? parseClaudeHelp(help.stdout) : undefined;
  const list = (items: readonly string[] | undefined): string => (items === undefined ? 'UNKNOWN (not readable from claude --help)' : items.join(', '));
  return (
    'Claude Code facts (read-only; no model was called)\n' +
    `  cli version: ${provider.version ?? 'UNKNOWN'} (claude --version)\n` +
    `  login: ${auth.state === 'logged-in' ? `${auth.method ?? 'UNKNOWN method'}${auth.plan === undefined ? '' : `, plan ${auth.plan}`}` : auth.state} (claude auth status)\n` +
    `  model aliases the CLI mentions: ${list(facts?.modelAliases)}  [examples quoted in --help; not a model list, not proof of access]\n` +
    `  effort levels the CLI accepts: ${list(facts?.efforts)}  [from --help; not per model]\n` +
    '  models this account can use: UNKNOWN  [no CLI command lists them; only a real call can prove access]\n' +
    '  active default model: UNKNOWN  [chosen by plan and account; restricted runs ignore user and project settings]\n' +
    '  efforts per model: UNKNOWN  [not reported by the CLI]\n' +
    '  ultracode support: UNKNOWN\n' +
    `  built-in registry: ${claudeRegistry.map((m) => m.id).join(', ')}  [shipped documentation, NOT evidence of access]\n`
  );
}
