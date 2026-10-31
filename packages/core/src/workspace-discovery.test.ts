import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverWorkspaces, selectWorkspace, suggestWorkspace, type Discovery, type WorkspaceCandidate } from './workspace-discovery.ts';

let base = '';
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'acl discovery ')); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const dir = (...p: string[]) => mkdir(join(base, ...p), { recursive: true });
const file = (p: string, text = '') => writeFile(join(base, p), text);
const discover = async (root = base): Promise<Discovery> => {
  const found = await discoverWorkspaces(root);
  if ('error' in found) throw new Error(found.error);
  return found;
};
const rels = (d: Discovery) => d.candidates.map((c) => c.relative);
const cand = (name: string, relative = name, extra: Partial<WorkspaceCandidate> = {}): WorkspaceCandidate => ({ path: `/r/${relative}`, relative, name, kind: 'project', monorepo: false, markers: [], ...extra });

describe('discoverWorkspaces', () => {
  it('finds a single repository at the root', async () => {
    await dir('.git');
    await file('package.json', '{"name":"solo"}');
    const d = await discover();
    expect(d.candidates).toHaveLength(1);
    expect(d.candidates[0]).toMatchObject({ relative: '.', kind: 'git-repo', packageName: 'solo' });
  });

  it('finds several repositories side by side and non-Git projects', async () => {
    await dir('api', '.git');
    await dir('web', '.git');
    await dir('scripts');
    await file('scripts/pyproject.toml');
    await dir('notes');
    const d = await discover();
    expect(rels(d)).toEqual(['.', 'api', 'scripts', 'web']);
    expect(d.candidates.find((c) => c.relative === 'scripts')).toMatchObject({ kind: 'project' });
    expect(d.candidates.find((c) => c.relative === 'api')).toMatchObject({ kind: 'git-repo' });
    expect(rels(d)).not.toContain('notes');
  });

  it('marks monorepo packages and the monorepo itself', async () => {
    await dir('.git');
    await file('pnpm-workspace.yaml');
    await file('package.json', '{"name":"mono","workspaces":["packages/*"]}');
    await dir('packages', 'core');
    await file('packages/core/package.json', '{"name":"@mono/core"}');
    await dir('packages', 'cli');
    await file('packages/cli/package.json', '{"name":"@mono/cli"}');
    const d = await discover();
    expect(d.candidates.find((c) => c.relative === '.')).toMatchObject({ kind: 'git-repo', monorepo: true });
    const core = d.candidates.find((c) => c.relative === join('packages', 'core'));
    expect(core).toMatchObject({ kind: 'package', packageName: '@mono/core', repoRoot: d.root, monorepo: false });
  });

  it('treats a nested repository as its own boundary, with its outer repository named', async () => {
    await dir('.git');
    await dir('vendor-tool', '.git');
    await dir('inner', '.git');
    await file('inner/package.json', '{"name":"inner"}');
    await dir('inner', 'pkg');
    await file('inner/pkg/package.json', '{"name":"pkg"}');
    const d = await discover();
    const inner = d.candidates.find((c) => c.relative === 'inner');
    expect(inner).toMatchObject({ kind: 'git-repo', nestedIn: d.root, repoRoot: join(d.root, 'inner') });
    expect(d.candidates.find((c) => c.relative === join('inner', 'pkg'))).toMatchObject({ kind: 'package', repoRoot: join(d.root, 'inner') });
    expect(d.candidates.find((c) => c.relative === '.')?.nestedIn).toBeUndefined();
  });

  it('tells linked worktrees and submodules (a .git file) from repositories', async () => {
    await dir('wt');
    await file('wt/.git', 'gitdir: /somewhere/main/.git/worktrees/wt\n');
    await dir('sub');
    await file('sub/.git', 'gitdir: ../.git/modules/sub\n');
    const d = await discover();
    expect(d.candidates.find((c) => c.relative === 'wt')?.kind).toBe('git-worktree');
    expect(d.candidates.find((c) => c.relative === 'sub')?.kind).toBe('git-submodule');
  });

  it('reports the Git repository above a root chosen inside it', async () => {
    await dir('.git');
    await dir('app');
    await file('app/package.json', '{"name":"app"}');
    const d = await discover(join(base, 'app'));
    expect(d.enclosingRepo).toBe(dirname(d.root));
    expect(d.candidates[0]).toMatchObject({ relative: '.', kind: 'package' });
  });

  it('never follows symlinks, even to a repository outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'acl outside '));
    try {
      await mkdir(join(outside, '.git'));
      await writeFile(join(outside, 'package.json'), '{"name":"outside"}');
      await dir('root');
      await dir('root', 'real', '.git');
      await symlink(outside, join(base, 'root', 'link'));
      await symlink(join(base, 'root', 'real'), join(base, 'root', 'alias'));
      const d = await discover(join(base, 'root'));
      expect(rels(d)).toEqual(['.', 'real']);
      expect(d.skipped.filter((s) => s.reason === 'symlink').map((s) => s.relative).sort()).toEqual(['alias', 'link']);
      expect(JSON.stringify(d)).not.toContain('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not enter hidden or dependency directories, and ignores a symlinked .git', async () => {
    await dir('.hidden', 'x');
    await file('.hidden/x/package.json');
    await dir('node_modules', 'dep');
    await file('node_modules/dep/package.json');
    await dir('tricky');
    await file('tricky/package.json', '{"name":"tricky"}');
    await symlink(join(base, 'node_modules'), join(base, 'tricky', '.git'));
    const d = await discover();
    expect(rels(d)).toEqual(['.', 'tricky']);
    expect(d.candidates.find((c) => c.relative === 'tricky')?.kind).toBe('project');
  });

  it('reads no secret files: only names, package.json and .git files are opened', async () => {
    await dir('svc');
    await file('svc/.env', 'TOKEN=sk-live-0123456789abcdef');
    await file('svc/id_rsa', 'PRIVATE KEY');
    await file('svc/package.json', '{"name":"svc"}');
    const d = await discover();
    const text = JSON.stringify(d);
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('PRIVATE');
    expect(d.candidates.find((c) => c.relative === 'svc')?.markers).toEqual(['package.json']);
  });

  it('ignores an oversized or malformed package.json instead of failing', async () => {
    await dir('big');
    await file('big/package.json', `{"name":"big","pad":"${'x'.repeat(70_000)}"}`);
    await dir('bad');
    await file('bad/package.json', '{nope');
    const d = await discover();
    expect(d.candidates.find((c) => c.relative === 'big')).toBeDefined();
    expect(d.candidates.find((c) => c.relative === 'big')?.packageName).toBeUndefined();
    expect(d.candidates.find((c) => c.relative === 'bad')?.packageName).toBeUndefined();
  });

  it('stops at its limits and says so', async () => {
    await dir('a', 'b', 'c');
    await file('a/b/c/package.json');
    const shallow = await discoverWorkspaces(base, { maxDepth: 1, maxDirs: 100, maxCandidates: 10 });
    if ('error' in shallow) throw new Error(shallow.error);
    expect(shallow.skipped).toContainEqual({ relative: join('a', 'b'), reason: 'depth-limit' });
    for (const n of ['p1', 'p2', 'p3']) {
      await dir(n);
      await file(`${n}/package.json`);
    }
    const few = await discoverWorkspaces(base, { maxDepth: 5, maxDirs: 100, maxCandidates: 2 });
    if ('error' in few) throw new Error(few.error);
    expect(few.candidates).toHaveLength(2);
    expect(few.truncated).toBe(true);
  });

  it('errors on a missing root or a file', async () => {
    expect(await discoverWorkspaces(join(base, 'nope'))).toEqual({ error: 'the root cannot be read' });
    await file('f.txt');
    expect(await discoverWorkspaces(join(base, 'f.txt'))).toEqual({ error: 'the root is not a directory' });
  });
});

describe('suggestWorkspace', () => {
  const cs = [cand('billing-api', 'services/billing-api'), cand('web-app', 'apps/web-app', { packageName: '@acme/web' }), cand('docs', 'docs'), cand('shared', 'packages/shared'), cand('shared', 'legacy/shared')];

  it('suggests a single clear match with reasons, and is deterministic', () => {
    const a = suggestWorkspace('Fix the rounding bug in billing-api invoices', cs);
    expect(a).toMatchObject({ state: 'suggested', best: { candidate: { relative: 'services/billing-api' } } });
    if (a.state === 'suggested') expect(a.best.reasons.join()).toContain('billing-api');
    expect(suggestWorkspace('Fix the rounding bug in billing-api invoices', [...cs].reverse())).toEqual(a);
  });

  it('prefers an explicit path mention and matches the package name without its scope', () => {
    expect(suggestWorkspace('Update legacy/shared helpers', cs)).toMatchObject({ state: 'suggested', best: { candidate: { relative: 'legacy/shared' } } });
    expect(suggestWorkspace('Add a button to @acme/web', cs)).toMatchObject({ state: 'suggested', best: { candidate: { relative: 'apps/web-app' } } });
    expect(suggestWorkspace('web ekranını düzelt', cs)).toMatchObject({ state: 'suggested', best: { candidate: { name: 'web-app' } } });
  });

  it('folds Turkish letters and case', () => {
    const turkish = [cand('Şarkı-Servisi', 'sarki-servisi'), cand('x', 'x')];
    expect(suggestWorkspace('ŞARKI SERVİSİ içindeki hatayı düzelt', turkish)).toMatchObject({ state: 'suggested' });
  });

  it('refuses to choose when two candidates match equally', () => {
    const s = suggestWorkspace('Refactor the shared helpers', cs);
    expect(s.state).toBe('ambiguous');
    if (s.state === 'ambiguous') expect(s.matches.map((m) => m.candidate.relative).sort()).toEqual(['legacy/shared', 'packages/shared']);
  });

  it('refuses when the task names two different projects', () => {
    expect(suggestWorkspace('Make billing-api call docs', cs).state).toBe('ambiguous');
  });

  it('returns none for unrelated or generic text', () => {
    expect(suggestWorkspace('Improve performance', cs)).toEqual({ state: 'none' });
    expect(suggestWorkspace('src app packages', [cand('app'), cand('src')])).toEqual({ state: 'none' });
    expect(suggestWorkspace('', cs)).toEqual({ state: 'none' });
  });

  it('does not match a name inside a longer word', () => {
    expect(suggestWorkspace('Update the documentsx index', [cand('docs')]).state).toBe('none');
    expect(suggestWorkspace('webapplication', [cand('web')]).state).toBe('none');
  });
});

describe('selectWorkspace', () => {
  const cs = [cand('shared', 'packages/shared'), cand('shared', 'legacy/shared'), cand('cli', 'apps/cli', { packageName: '@x/cli' })];
  it('chooses by relative path, name or package name', () => {
    expect(selectWorkspace(cs, 'apps/cli')).toMatchObject({ ok: true, candidate: { name: 'cli' } });
    expect(selectWorkspace(cs, 'cli')).toMatchObject({ ok: true });
    expect(selectWorkspace(cs, '@x/cli')).toMatchObject({ ok: true });
    expect(selectWorkspace(cs, 'legacy/shared/')).toMatchObject({ ok: true, candidate: { relative: 'legacy/shared' } });
  });
  it('refuses an ambiguous name and an unknown choice', () => {
    expect(selectWorkspace(cs, 'shared')).toMatchObject({ ok: false, error: expect.stringContaining('choose by relative path') as unknown });
    expect(selectWorkspace(cs, '../etc')).toMatchObject({ ok: false });
  });
});
