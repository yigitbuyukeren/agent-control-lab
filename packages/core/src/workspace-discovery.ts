import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

/**
 * Read-only workspace discovery under a user-chosen root. It lists directory names and reads only a few
 * small, non-secret manifest files (`package.json` for a name, a `.git` file for its `gitdir:` line). It
 * never follows symlinks, never enters hidden or dependency directories, never runs git and never
 * opens `.env*`, key files or anything else that could hold a secret.
 */
export type CandidateKind = 'git-repo' | 'git-worktree' | 'git-submodule' | 'package' | 'project';

export interface WorkspaceCandidate {
  readonly path: string;
  /** Path relative to the discovery root; `.` for the root itself. */
  readonly relative: string;
  readonly name: string;
  readonly kind: CandidateKind;
  /** The Git repository this directory is, or sits inside (absolute path). */
  readonly repoRoot?: string;
  /** For a repository inside another repository: the outer one's absolute path. */
  readonly nestedIn?: string;
  readonly monorepo: boolean;
  readonly markers: readonly string[];
  readonly packageName?: string;
}

export type SkipReason = 'symlink' | 'unreadable' | 'depth-limit' | 'entry-limit';

export interface DiscoverySkip {
  readonly relative: string;
  readonly reason: SkipReason;
}

export interface Discovery {
  readonly root: string;
  /** Set when the root is itself inside a Git repository above it. */
  readonly enclosingRepo?: string;
  readonly candidates: readonly WorkspaceCandidate[];
  readonly skipped: readonly DiscoverySkip[];
  readonly truncated: boolean;
}

export interface DiscoveryLimits {
  readonly maxDepth: number;
  readonly maxDirs: number;
  readonly maxCandidates: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = { maxDepth: 5, maxDirs: 4000, maxCandidates: 200 };

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SKIPPED = 100;

/** Directories that never hold a project of their own, whatever they contain. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'site-packages', 'bower_components', 'pods', 'deriveddata',
]);

/** Files whose presence marks a directory as a project. Names only; only `package.json` is ever read. */
const PROJECT_MARKERS: readonly string[] = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile', 'composer.json', 'Package.swift', 'CMakeLists.txt', 'deno.json', 'mix.exs', 'pubspec.yaml',
];
const MONOREPO_MARKERS: readonly string[] = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'];

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

interface Manifest {
  readonly name?: string;
  readonly workspaces: boolean;
}

async function readManifest(dir: string): Promise<Manifest> {
  const text = await readSmall(join(dir, 'package.json'));
  if (text === undefined) return { workspaces: false };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { workspaces: false };
    const record = parsed as Record<string, unknown>;
    const name = typeof record['name'] === 'string' && record['name'].length <= 200 ? record['name'] : undefined;
    return { ...(name === undefined ? {} : { name }), workspaces: record['workspaces'] !== undefined };
  } catch {
    return { workspaces: false };
  }
}

type GitKind = 'git-repo' | 'git-worktree' | 'git-submodule';

/** What `.git` is in `dir`: a directory (repository), or a file whose `gitdir:` line tells worktree from submodule. */
async function gitKindOf(dir: string): Promise<GitKind | undefined> {
  const gitPath = join(dir, '.git');
  let info;
  try {
    info = await lstat(gitPath);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return 'git-repo';
  if (!info.isFile()) return undefined; // a symlinked or odd `.git` is not trusted as a boundary
  const text = await readSmall(gitPath);
  const target = text?.match(/^gitdir:\s*(.+)$/m)?.[1]?.replaceAll('\\', '/') ?? '';
  if (/\/worktrees\/[^/]+\/?$/.test(target)) return 'git-worktree';
  if (/\/modules\//.test(target)) return 'git-submodule';
  return 'git-repo';
}

async function enclosingRepoOf(root: string): Promise<string | undefined> {
  if (dirname(root) === root) return undefined;
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    if ((await gitKindOf(dir)) !== undefined) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

export async function discoverWorkspaces(rootInput: string, limits: DiscoveryLimits = DEFAULT_DISCOVERY_LIMITS): Promise<Discovery | { readonly error: string }> {
  let root: string;
  try {
    root = await realpath(rootInput);
    if (!(await lstat(root)).isDirectory()) return { error: 'the root is not a directory' };
  } catch {
    return { error: 'the root cannot be read' };
  }
  const candidates: WorkspaceCandidate[] = [];
  const skipped: DiscoverySkip[] = [];
  let truncated = false;
  let visited = 0;
  const skip = (path: string, reason: SkipReason): void => {
    if (skipped.length < MAX_SKIPPED) skipped.push({ relative: relative(root, path) || '.', reason });
  };
  const enclosingRepo = await enclosingRepoOf(root);

  async function visit(dir: string, depth: number, repo: string | undefined): Promise<void> {
    visited += 1;
    if (visited > limits.maxDirs) {
      truncated = true;
      skip(dir, 'entry-limit');
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skip(dir, 'unreadable');
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const gitKind = await gitKindOf(dir);
    const markers = [...PROJECT_MARKERS, ...MONOREPO_MARKERS].filter((m) => files.has(m));
    const manifest = files.has('package.json') ? await readManifest(dir) : { workspaces: false };
    const monorepo = markers.some((m) => MONOREPO_MARKERS.includes(m)) || manifest.workspaces;
    const hasProject = markers.some((m) => PROJECT_MARKERS.includes(m));
    const ownRepo = gitKind !== undefined ? dir : repo;
    const isRoot = dir === root;
    // The root is always offered (it is what the user chose); other directories only when they are a repo or a project.
    let kind: CandidateKind | undefined;
    if (gitKind !== undefined) kind = gitKind;
    else if (hasProject) kind = repo !== undefined ? 'package' : 'project';
    else if (isRoot) kind = 'project';
    if (kind !== undefined) {
      if (candidates.length >= limits.maxCandidates) {
        truncated = true;
      } else {
        const outer = gitKind !== undefined ? repo : undefined;
        candidates.push({
          path: dir,
          relative: relative(root, dir) || '.',
          name: isRoot ? basename(root) : basename(dir),
          kind,
          ...(ownRepo === undefined ? {} : { repoRoot: ownRepo }),
          ...(outer === undefined ? {} : { nestedIn: outer }),
          monorepo,
          markers,
          ...(manifest.name === undefined ? {} : { packageName: manifest.name }),
        });
      }
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Never followed: its target is unknown territory and could leave the chosen root.
        skip(child, 'symlink');
        continue;
      }
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
      if (depth + 1 > limits.maxDepth) {
        skip(child, 'depth-limit');
        continue;
      }
      await visit(child, depth + 1, ownRepo);
    }
  }

  await visit(root, 0, enclosingRepo);
  return { root, ...(enclosingRepo === undefined ? {} : { enclosingRepo }), candidates, skipped, truncated };
}

// ---------------------------------------------------------------------------------------------
// Suggestion from the task text

export interface ScoredCandidate {
  readonly candidate: WorkspaceCandidate;
  readonly score: number;
  readonly reasons: readonly string[];
}

export type Suggestion =
  | { readonly state: 'suggested'; readonly best: ScoredCandidate; readonly others: readonly ScoredCandidate[] }
  /** Several candidates match about equally: no choice is made, the user has to pick. */
  | { readonly state: 'ambiguous'; readonly matches: readonly ScoredCandidate[] }
  | { readonly state: 'none' };

const GENERIC_TOKENS: ReadonlySet<string> = new Set(['app', 'apps', 'packages', 'package', 'src', 'lib', 'libs', 'test', 'tests', 'the', 'and', 'for', 'ile', 'bir', 've']);
const SCORE_PATH = 12;
const SCORE_NAME = 10;
const SCORE_TOKEN = 3;
const MIN_SCORE = 3;
const MIN_MARGIN = 3;

/** Lower-case, with accents and the Turkish dotless i folded, so matching does not depend on the locale. */
export function fold(text: string): string {
  return text.replaceAll('İ', 'i').replaceAll('ı', 'i').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const tokensOf = (text: string): string[] => fold(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/** Deterministic: the same task and candidates always give the same answer; nothing is guessed when scores are close. */
export function suggestWorkspace(task: string, candidates: readonly WorkspaceCandidate[]): Suggestion {
  const folded = fold(task);
  const taskTokens = new Set(tokensOf(task));
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    let score = 0;
    const reasons: string[] = [];
    const rel = fold(candidate.relative).replaceAll('\\', '/');
    if (rel !== '.' && rel.includes('/') && folded.includes(rel)) {
      score += SCORE_PATH;
      reasons.push(`task mentions the path "${candidate.relative}"`);
    }
    const names = new Set([candidate.name, candidate.packageName ?? '', (candidate.packageName ?? '').replace(/^@[^/]+\//, '')].map(fold).filter((n) => n.length >= 2 && !GENERIC_TOKENS.has(n)));
    for (const name of names) {
      if (new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(folded)) {
        score += SCORE_NAME;
        reasons.push(`task mentions the name "${name}"`);
        break;
      }
    }
    if (score === 0) {
      const own = new Set([...names].flatMap((n) => tokensOf(n)).filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t)));
      const hit = [...own].filter((t) => taskTokens.has(t));
      if (hit.length > 0) {
        score += SCORE_TOKEN * hit.length;
        reasons.push(`task shares ${hit.length === 1 ? 'the word' : 'the words'} ${hit.map((h) => `"${h}"`).join(', ')} with the name`);
      }
    }
    if (score > 0) scored.push({ candidate, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.relative.localeCompare(b.candidate.relative));
  const [best, second] = scored;
  if (best === undefined || best.score < MIN_SCORE) return { state: 'none' };
  if (second !== undefined && best.score - second.score < MIN_MARGIN) {
    return { state: 'ambiguous', matches: scored.filter((s) => best.score - s.score < MIN_MARGIN) };
  }
  return { state: 'suggested', best, others: scored.slice(1) };
}

/**
 * A manual choice by relative path or name. A name shared by several candidates is refused instead of
 * picking one of them.
 */
export function selectWorkspace(candidates: readonly WorkspaceCandidate[], choice: string): { readonly ok: true; readonly candidate: WorkspaceCandidate } | { readonly ok: false; readonly error: string } {
  const normal = choice.replaceAll('\\', '/').replace(/\/+$/, '');
  const byPath = candidates.filter((c) => c.relative === normal);
  if (byPath.length === 1 && byPath[0] !== undefined) return { ok: true, candidate: byPath[0] };
  const byName = candidates.filter((c) => c.name === choice || c.packageName === choice);
  if (byName.length === 1 && byName[0] !== undefined) return { ok: true, candidate: byName[0] };
  if (byName.length > 1) return { ok: false, error: `"${choice}" matches ${String(byName.length)} candidates (${byName.map((c) => c.relative).join(', ')}); choose by relative path` };
  return { ok: false, error: `"${choice}" is not a discovered candidate` };
}
