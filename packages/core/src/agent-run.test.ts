import { describe, expect, it } from 'vitest';
import { runAgent } from './agent-run.ts';
import { buildClaudePrintArgs, claudeAllowRules } from './claude-run.ts';
import { claudeRegistry } from './models.ts';
import { PERMISSION_PROFILES, codexSandboxFor, profileProblem } from './permission-profile.ts';
import type { ProcessSpec } from './process-runner.ts';
import { DEFAULT_REQUEST, resolveSelection } from './selection.ts';
import { SELECTION_STEPS } from './step-selection.ts';

const selection = (provider: 'claude' | 'codex') =>
  resolveSelection(provider, DEFAULT_REQUEST, { claude: claudeRegistry, codex: { state: 'ok', models: [] } });

describe('Claude tool profiles', () => {
  it('text-only stays tool-less; tooled profiles never bypass permissions or use wildcards in Bash', () => {
    expect(buildClaudePrintArgs(selection('claude'))).toEqual(expect.arrayContaining(['--tools', '']));
    for (const profile of ['read-only', 'workspace-write'] as const) {
      const args = buildClaudePrintArgs(selection('claude'), { profile, terminal: ['pnpm test'] });
      expect(args).toEqual(expect.arrayContaining(['--restricted', '--permission-mode', 'dontAsk', '--no-session-persistence']));
      expect(args.join(' ')).not.toMatch(/bypass|dangerously|danger-full/i);
      const rules = claudeAllowRules({ profile, terminal: ['pnpm test'] });
      expect(rules.filter((r) => r.startsWith('Bash(')).some((r) => r.includes('*'))).toBe(false);
      expect(rules.includes('Edit')).toBe(profile === 'workspace-write');
      expect(rules.includes('Bash(pnpm test)')).toBe(profile === 'workspace-write');
    }
  });
  it('drops terminal commands with shell syntax', () => {
    expect(claudeAllowRules({ profile: 'workspace-write', terminal: ['pnpm test; id', 'rm -rf $HOME', 'pnpm test *'] }).filter((r) => /pnpm|rm/.test(r))).toEqual([]);
  });
});

describe('profile rules', () => {
  it('writes only in the implement step and codex has no text-only mode', () => {
    for (const step of SELECTION_STEPS) for (const provider of ['claude', 'codex'] as const) for (const profile of PERMISSION_PROFILES) {
      const problem = profileProblem(step, provider, profile);
      if (profile === 'workspace-write') expect(problem === undefined).toBe(step === 'implement');
      if (profile === 'text-only' && provider === 'codex') expect(problem).toBeDefined();
    }
    expect(codexSandboxFor('text-only')).toBeUndefined();
  });
  it('runAgent fails closed for codex + text-only and maps the others to sandboxes', async () => {
    const specs: ProcessSpec[] = [];
    const runner = (spec: ProcessSpec) => {
      specs.push(spec);
      return Promise.resolve({ kind: 'completed' as const, exitCode: 0, stdout: 'x', truncated: false });
    };
    const base = { prompt: 'p', cwd: '/w', timeoutMs: 1000, selection: selection('codex') };
    expect(await runAgent({ ...base, provider: 'codex', profile: 'text-only' }, { runner })).toEqual({ kind: 'failed' });
    expect(specs).toEqual([]);
    await runAgent({ ...base, provider: 'codex', profile: 'read-only' }, { runner });
    await runAgent({ ...base, provider: 'codex', profile: 'workspace-write' }, { runner });
    expect(specs.map((s) => s.args[s.args.indexOf('-s') + 1])).toEqual(['read-only', 'workspace-write']);
  });
});
