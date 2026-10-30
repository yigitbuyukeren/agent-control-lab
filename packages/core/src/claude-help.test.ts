import { describe, expect, it } from 'vitest';
import { parseClaudeHelp } from './claude-help.ts';
import { resolveSelection } from './selection.ts';
import { claudeRegistry } from './models.ts';

const HELP = `Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session
`;

describe('parseClaudeHelp', () => {
  it('reads the effort names and alias examples from wrapped option text', () => {
    expect(parseClaudeHelp(HELP)).toEqual({ modelAliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  it('reports UNKNOWN (undefined) when the help does not say, and never invents values', () => {
    expect(parseClaudeHelp('')).toEqual({ modelAliases: undefined, efforts: undefined });
    expect(parseClaudeHelp('  --effort <level>   Effort level')).toEqual({ modelAliases: undefined, efforts: undefined });
  });

  it('drops ultracode from the effort list and ignores text that is not a plain name list', () => {
    const help = '  --effort <level>   Effort (low, ultracode, max)\n';
    expect(parseClaudeHelp(help).efforts).toEqual(['low', 'max']);
    expect(parseClaudeHelp('  --effort <level>   Effort (HIGH!, max)\n').efforts).toBeUndefined();
  });
});

describe('resolveSelection with CLI-reported efforts', () => {
  const catalog = { claude: claudeRegistry, codex: { state: 'ok', models: [] } } as const;
  const efforts = ['low', 'medium', 'high'];

  it('blocks an effort the CLI does not list, with or without a pinned model', () => {
    for (const model of ['auto', 'claude-opus-5-5']) {
      const s = resolveSelection('claude', { model, effort: 'max', mode: 'normal' }, { ...catalog, claudeEfforts: efforts });
      expect(s.blocked).toBe(true);
      expect(s.issues).toContainEqual({ code: 'effort-unsupported', blocking: true, effort: 'max', supported: efforts });
    }
  });

  it('keeps an accepted effort unverified because per-model support is unknown', () => {
    const s = resolveSelection('claude', { model: 'claude-opus-5-5', effort: 'high', mode: 'normal' }, { ...catalog, claudeEfforts: efforts });
    expect(s.blocked).toBe(false);
    expect(s.effort).toEqual({ kind: 'explicit', value: 'high', verified: false });
    expect(s.manualApprovalRequired).toBe(true);
  });

  it('does not change Codex', () => {
    const codex = { state: 'ok', models: [] } as const;
    const s = resolveSelection('codex', { model: 'auto', effort: 'max', mode: 'normal' }, { claude: claudeRegistry, codex, claudeEfforts: efforts });
    expect(s.issues.map((i) => i.code)).toEqual(['effort-unverified']);
  });
});
