import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from './agent-run.ts';
import { buildClaudePrintArgs, claudeAllowRules, claudeProtectedPathRules } from './claude-run.ts';
import { claudeRegistry } from './models.ts';
import { PERMISSION_PROFILES, codexSandboxFor, profileProblem } from './permission-profile.ts';
import type { ProcessSpec } from './process-runner.ts';
import { DEFAULT_REQUEST, resolveSelection } from './selection.ts';
import { isProtectedPath } from './workspace-policy.ts';
import { SELECTION_STEPS } from './step-selection.ts';

const selection = (provider: 'claude' | 'codex') =>
  resolveSelection(provider, DEFAULT_REQUEST, { claude: claudeRegistry, codex: { state: 'ok', models: [] } });

const rulesOf = (kind: 'Edit' | 'Read', denied: readonly string[]): string[] =>
  denied.filter((r) => r.startsWith(`${kind}(`) && r.endsWith(')')).map((r) => r.slice(kind.length + 1, -1));

/** Evaluates deny patterns with Git's own gitignore engine, the syntax the Claude docs specify for Read/Edit rules. */
function matchedBy(patterns: readonly string[], paths: readonly string[]): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), 'acl rules '));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), `${patterns.join('\n')}\n`);
    const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: dir, input: paths.join('\n'), encoding: 'utf8' }).trim();
    return new Set(out === '' ? [] : out.split('\n'));
  } catch (error) {
    // check-ignore exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return new Set();
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Claude tool profiles', () => {
  it('text-only stays tool-less; tooled profiles have no shell, no bypass and no wildcard allow rules', () => {
    expect(buildClaudePrintArgs(selection('claude'))).toEqual(expect.arrayContaining(['--tools', '']));
    for (const profile of ['read-only', 'workspace-write'] as const) {
      const args = buildClaudePrintArgs(selection('claude'), { profile });
      expect(args).toEqual(expect.arrayContaining(['--restricted', '--permission-mode', 'dontAsk', '--no-session-persistence']));
      expect(args.join(' ')).not.toMatch(/bypass|dangerously|danger-full/i);
      const tools = (args[args.indexOf('--tools') + 1] ?? '').split(',');
      expect(tools).not.toContain('Bash');
      expect(tools.includes('Edit')).toBe(profile === 'workspace-write');
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
      expect(allowed).toEqual(claudeAllowRules({ profile }));
      expect(allowed.some((r) => r.includes('Bash') || r.includes('*') || r.includes('('))).toBe(false);
      expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(expect.arrayContaining(['Bash']));
    }
  });
  it('builds only Edit(path) and Read(path) rules: Write(path) never matches in Claude Code', () => {
    const deny = claudeProtectedPathRules();
    expect(deny.some((r) => r.startsWith('Write(') || r.startsWith('Glob(') || r.startsWith('NotebookEdit('))).toBe(false);
    expect(deny.every((r) => r.startsWith('Edit(') || r.startsWith('Read('))).toBe(true);
  });
  it('effective behaviour: the deny patterns match exactly the protected paths (gitignore engine), not ordinary files', () => {
    const deny = claudeProtectedPathRules();
    const sample = [
      '.env', '.env.local', 'apps/web/.env', 'apps/web/.env.production', '.github/workflows/ci.yml', '.github/workflows/sub/x.yml',
      '.git/config', 'pkg/.git/hooks/pre-commit', '.claude/settings.json', 'a/.claude/x', '.codex/config.toml', '.husky/pre-commit',
      '.npmrc', 'pkg/.npmrc', '.pnpmrc', '.yarnrc.yml', '.gitmodules', '.gitattributes', 'CLAUDE.md', 'docs/AGENTS.md', 'agents.md',
      'src/index.ts', 'README.md', '.github/CODEOWNERS', '.github/workflows.md', 'env.ts', 'src/environment.ts', '.envrc', 'docs/claude-notes.md', 'gitignore.txt', 'src/.github/x',
    ];
    const edit = matchedBy(rulesOf('Edit', deny), sample);
    const read = matchedBy(rulesOf('Read', deny), sample);
    const readable = new Set(['.gitmodules', '.gitattributes', 'CLAUDE.md', 'docs/AGENTS.md', 'agents.md']);
    for (const path of sample) {
      const protectedPath = isProtectedPath(path);
      expect(edit.has(path), `Edit ${path}`).toBe(protectedPath);
      expect(read.has(path), `Read ${path}`).toBe(protectedPath && !readable.has(path));
    }
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
