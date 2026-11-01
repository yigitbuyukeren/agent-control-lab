import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type InstructionProvider = 'claude' | 'codex';
export type InstructionScope = 'managed' | 'user' | 'project' | 'local' | 'subdirectory';
/** Whether the provider reads the file by itself in the mode this tool runs it in. */
export type LoadStatus = 'loaded' | 'on-demand' | 'shadowed' | 'not-loaded' | 'unknown' | 'skipped';

export interface InstructionEntry {
  readonly provider: InstructionProvider;
  readonly path: string;
  readonly scope: InstructionScope;
  readonly kind: string;
  /** Position in the provider's own load order (lower loads first, a later file wins on conflict). */
  readonly order: number;
  readonly status: LoadStatus;
  readonly reason: string;
  readonly bytes: number;
  readonly sha256: string | undefined;
  readonly imports: readonly string[];
  readonly flags: readonly string[];
}

export interface InstructionConflict {
  readonly kind: 'cross-provider-divergence' | 'override-shadows' | 'duplicate-content' | 'import-duplicates';
  readonly paths: readonly string[];
  readonly detail: string;
}

export interface ResolvedInstructions {
  readonly provider: InstructionProvider;
  readonly cwd: string;
  readonly repoRoot: string | undefined;
  readonly entries: readonly InstructionEntry[];
  readonly conflicts: readonly InstructionConflict[];
  readonly warnings: readonly string[];
}

export interface ResolveOptions {
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform;
  /**
   * How the provider is started. `restricted` is this tool's own safe mode for Claude
   * (`--safe-mode --restricted`, which ignores user and project settings); whether memory files are
   * still read there is not documented, so they stay `unknown` instead of being claimed as loaded.
   */
  readonly claudeMode?: 'restricted' | 'normal';
}

/** One file is read at most this far; a larger one is listed but never hashed or quoted. */
export const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024;
/** Codex stops reading project instructions after this many bytes in total (`project_doc_max_bytes`). */
export const CODEX_PROJECT_DOC_BYTES = 32 * 1024;
const MAX_RULE_FILES = 200;
const MAX_ANCESTORS = 64;

const SUSPICIOUS: readonly (readonly [RegExp, string])[] = [
  [/ignore (all |any )?(previous|prior|above) (instructions|rules)/i, 'tries to override earlier instructions'],
  [/dangerously-skip-permissions|--bypass|disable (the )?sandbox/i, 'asks to bypass permissions or the sandbox'],
  [/(curl|wget)[^\n|]*\|\s*(ba|z)?sh/i, 'pipes a download into a shell'],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*\S{12,}/i, 'looks like it contains a credential'],
];

const SECRET_LINE = /(api[_-]?key|secret|token|password|passwd|bearer|private[_ -]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/i;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

async function findRepoRoot(cwd: string): Promise<string | undefined> {
  let dir = cwd;
  for (let i = 0; i < MAX_ANCESTORS; i += 1) {
    try {
      await lstat(join(dir, '.git'));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Directories from `top` down to `cwd` (inclusive), both already resolved. */
function chain(top: string, cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_ANCESTORS; i += 1) {
    dirs.unshift(dir);
    if (dir === top) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

interface Candidate {
  readonly path: string;
  readonly scope: InstructionScope;
  readonly kind: string;
  readonly status: LoadStatus;
  readonly reason: string;
}

async function describe(candidate: Candidate, order: number, provider: InstructionProvider, allowedRoot: string | undefined): Promise<InstructionEntry | undefined> {
  let info: Stats;
  try {
    info = await lstat(candidate.path);
  } catch {
    return undefined;
  }
  const base = { provider, path: candidate.path, scope: candidate.scope, kind: candidate.kind, order, imports: [] as string[], flags: [] as string[] };
  const skip = (reason: string): InstructionEntry => ({ ...base, status: 'skipped', reason, bytes: info.size, sha256: undefined });
  let target = candidate.path;
  if (info.isSymbolicLink()) {
    try {
      target = await realpath(candidate.path);
    } catch {
      return skip('broken symlink');
    }
    // A project file must not read from outside the project through a link; user files may link anywhere in their own tree.
    if (allowedRoot !== undefined && !isInside(allowedRoot, target)) return skip('symlink leaves the project');
    info = await stat(target);
  }
  if (!info.isFile()) return undefined;
  if (info.size > MAX_INSTRUCTION_FILE_BYTES) return skip(`larger than ${String(MAX_INSTRUCTION_FILE_BYTES)} bytes`);
  let data: Buffer;
  try {
    data = await readFile(target);
  } catch {
    return skip('unreadable');
  }
  const text = data.toString('utf8');
  const flags = SUSPICIOUS.filter(([re]) => re.test(text)).map(([, why]) => why);
  const imports = [...text.matchAll(/(?:^|\s)@([\w./~-][^\s]*)/g)].map((m) => m[1] ?? '').filter((p) => p.includes('/') || p.includes('.')).slice(0, 20);
  return { ...base, status: candidate.status, reason: candidate.reason, bytes: data.length, sha256: sha(data), imports, flags };
}

async function ruleFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= MAX_RULE_FILES) return;
    let names;
    try {
      names = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md') && found.length < MAX_RULE_FILES) found.push(full);
    }
  };
  await walk(dir, 0);
  return found;
}

async function claudeCandidates(cwd: string, top: string, home: string | undefined, platform: NodeJS.Platform, mode: 'restricted' | 'normal'): Promise<Candidate[]> {
  const memory: LoadStatus = mode === 'restricted' ? 'unknown' : 'loaded';
  const why = mode === 'restricted' ? 'started with --safe-mode --restricted, which ignores user and project settings; memory loading there is not documented' : 'read by Claude Code at start';
  const out: Candidate[] = [];
  const managed = platform === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md' : platform === 'win32' ? undefined : '/etc/claude-code/CLAUDE.md';
  if (managed !== undefined) out.push({ path: managed, scope: 'managed', kind: 'managed policy CLAUDE.md', status: memory, reason: why });
  if (home !== undefined) {
    out.push({ path: join(home, '.claude', 'CLAUDE.md'), scope: 'user', kind: 'user CLAUDE.md', status: memory, reason: why });
    for (const rule of await ruleFiles(join(home, '.claude', 'rules'))) out.push({ path: rule, scope: 'user', kind: 'user rule', status: memory, reason: why });
  }
  for (const dir of chain(top, cwd)) {
    const here = dir === cwd;
    const scope: InstructionScope = here || dir === top ? 'project' : 'subdirectory';
    out.push({ path: join(dir, 'CLAUDE.md'), scope, kind: 'CLAUDE.md', status: memory, reason: why });
    out.push({ path: join(dir, '.claude', 'CLAUDE.md'), scope, kind: '.claude/CLAUDE.md', status: memory, reason: why });
    out.push({ path: join(dir, 'CLAUDE.local.md'), scope: 'local', kind: 'CLAUDE.local.md', status: memory, reason: `${why}; personal file, never exported` });
    for (const rule of await ruleFiles(join(dir, '.claude', 'rules'))) out.push({ path: rule, scope, kind: 'project rule', status: memory, reason: why });
  }
  return out;
}

function codexCandidates(cwd: string, top: string, home: string | undefined): Candidate[] {
  const out: Candidate[] = [];
  const codexHome = home === undefined ? undefined : join(home, '.codex');
  if (codexHome !== undefined) {
    out.push({ path: join(codexHome, 'AGENTS.override.md'), scope: 'user', kind: 'user AGENTS.override.md', status: 'loaded', reason: 'global override read first' });
    out.push({ path: join(codexHome, 'AGENTS.md'), scope: 'user', kind: 'user AGENTS.md', status: 'loaded', reason: 'global instructions' });
  }
  for (const dir of chain(top, cwd)) {
    const scope: InstructionScope = dir === cwd || dir === top ? 'project' : 'subdirectory';
    out.push({ path: join(dir, 'AGENTS.override.md'), scope, kind: 'AGENTS.override.md', status: 'loaded', reason: 'override in this directory' });
    out.push({ path: join(dir, 'AGENTS.md'), scope, kind: 'AGENTS.md', status: 'loaded', reason: 'read from the repository root down to the working directory' });
  }
  return out;
}

/** Finds which instruction files a provider would use for `cwd`, without ever changing them. */
export async function resolveInstructions(provider: InstructionProvider, cwdInput: string, options: ResolveOptions = {}): Promise<ResolvedInstructions> {
  const cwd = await realpath(resolve(cwdInput)).catch(() => resolve(cwdInput));
  const repoRoot = await findRepoRoot(cwd);
  const top = repoRoot ?? cwd;
  const home = 'home' in options ? options.home : homedir();
  const platform = options.platform ?? process.platform;
  const candidates = provider === 'claude' ? await claudeCandidates(cwd, top, home, platform, options.claudeMode ?? 'restricted') : codexCandidates(cwd, top, home);
  const warnings: string[] = [];
  const entries: InstructionEntry[] = [];
  for (const candidate of candidates) {
    const entry = await describe(candidate, entries.length, provider, candidate.scope === 'user' || candidate.scope === 'managed' ? undefined : top);
    if (entry !== undefined) entries.push(entry);
  }

  // Codex reads one file per directory: AGENTS.override.md replaces AGENTS.md next to it, and the user-level pair works the same way,
  // and it stops after a byte budget.
  let adjusted = entries;
  if (provider === 'codex') {
    const present = new Set(entries.filter((e) => e.kind.endsWith('AGENTS.override.md') && e.status !== 'skipped').map((e) => dirname(e.path)));
    adjusted = entries.map((e) => (e.kind.endsWith('AGENTS.md') && !e.kind.endsWith('override.md') && present.has(dirname(e.path)) ? { ...e, status: 'shadowed' as const, reason: 'AGENTS.override.md in the same directory replaces it' } : e));
    let used = 0;
    adjusted = adjusted.map((e) => {
      if (e.scope === 'user' || e.status !== 'loaded') return e;
      used += e.bytes;
      return used > CODEX_PROJECT_DOC_BYTES ? { ...e, status: 'not-loaded' as const, reason: `beyond Codex's ${String(CODEX_PROJECT_DOC_BYTES)}-byte project instruction budget` } : e;
    });
    if (used > CODEX_PROJECT_DOC_BYTES) warnings.push(`project instructions total ${String(used)} bytes; Codex stops reading at ${String(CODEX_PROJECT_DOC_BYTES)}`);
  }
  if (provider === 'claude') {
    adjusted = adjusted.map((e) => (e.scope === 'subdirectory' && e.status === 'loaded' ? { ...e, status: 'on-demand' as const, reason: 'subdirectory file; read when Claude works in that directory' } : e));
  }
  if (adjusted.some((e) => e.flags.length > 0)) warnings.push('some instruction files contain suspicious text; they are treated as untrusted data and never raise permissions');
  return { provider, cwd, repoRoot, entries: adjusted, conflicts: findConflicts(adjusted), warnings };
}

function findConflicts(entries: readonly InstructionEntry[]): InstructionConflict[] {
  const conflicts: InstructionConflict[] = [];
  const byHash = new Map<string, InstructionEntry[]>();
  for (const entry of entries) {
    if (entry.sha256 === undefined || entry.status === 'skipped') continue;
    byHash.set(entry.sha256, [...(byHash.get(entry.sha256) ?? []), entry]);
  }
  for (const group of byHash.values()) {
    if (group.length > 1) conflicts.push({ kind: 'duplicate-content', paths: group.map((e) => e.path), detail: 'identical content in several files: it would be loaded more than once' });
  }
  for (const entry of entries) {
    if (entry.status === 'shadowed') conflicts.push({ kind: 'override-shadows', paths: [entry.path], detail: entry.reason });
  }
  return conflicts;
}

/** Compares what both providers would read in the same project and reports divergence between CLAUDE.md and AGENTS.md. */
export function crossProviderConflicts(claude: ResolvedInstructions, codex: ResolvedInstructions): InstructionConflict[] {
  const conflicts: InstructionConflict[] = [];
  for (const c of claude.entries) {
    if (c.kind !== 'CLAUDE.md' || c.sha256 === undefined) continue;
    const peer = codex.entries.find((e) => e.kind === 'AGENTS.md' && dirname(e.path) === dirname(c.path) && e.sha256 !== undefined);
    if (peer === undefined) continue;
    if (peer.sha256 !== c.sha256 && !c.imports.some((i) => i.endsWith('AGENTS.md'))) {
      conflicts.push({ kind: 'cross-provider-divergence', paths: [c.path, peer.path], detail: 'CLAUDE.md and AGENTS.md differ and CLAUDE.md does not import AGENTS.md; the two agents follow different rules here' });
    } else if (c.imports.some((i) => i.endsWith('AGENTS.md'))) {
      conflicts.push({ kind: 'import-duplicates', paths: [c.path, peer.path], detail: 'CLAUDE.md imports AGENTS.md; passing both would load the same text twice' });
    }
  }
  return conflicts;
}

export interface ContextOptions {
  /** Total characters allowed in the exported context. */
  readonly maxChars?: number;
  readonly perFileChars?: number;
}

export interface InstructionContext {
  readonly text: string;
  readonly included: readonly string[];
  readonly excluded: readonly { readonly path: string; readonly reason: string }[];
}

const DEFAULT_CONTEXT_CHARS = 8000;
const DEFAULT_PER_FILE_CHARS = 3000;

/**
 * Builds a bounded excerpt of the project's own instruction files for a provider that does not read them
 * itself (for example a restricted Claude run). Only tracked-project files are used: user-level and local
 * files are never exported, identical files appear once, and secret-looking lines are dropped. The result
 * is data for an untrusted block, never a permission.
 */
export async function buildInstructionContext(resolved: ResolvedInstructions, options: ContextOptions = {}): Promise<InstructionContext> {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_CHARS;
  const perFile = options.perFileChars ?? DEFAULT_PER_FILE_CHARS;
  const parts: string[] = [];
  const included: string[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const entry of resolved.entries) {
    const drop = (reason: string): void => {
      excluded.push({ path: entry.path, reason });
    };
    if (entry.scope === 'user' || entry.scope === 'managed') drop('personal or machine-wide file is never exported');
    else if (entry.scope === 'local') drop('local personal file is never exported');
    else if (entry.status === 'skipped' || entry.status === 'shadowed') drop(entry.reason);
    else if (entry.status === 'loaded') drop('the provider already reads it itself');
    else if (entry.sha256 === undefined) drop('not readable');
    else if (seen.has(entry.sha256)) drop('same content already included');
    else if (used >= maxChars) drop('context budget used up');
    else {
      let text: string;
      try {
        text = (await readFile(entry.path)).toString('utf8');
      } catch {
        drop('unreadable');
        continue;
      }
      const kept = text.split(/\r?\n/).filter((line) => !SECRET_LINE.test(line)).join('\n').replace(CONTROL_CHARS, '');
      const cut = kept.length > perFile ? `${kept.slice(0, perFile)}\n[cut]` : kept;
      const room = Math.max(0, maxChars - used);
      const piece = cut.length > room ? `${cut.slice(0, room)}\n[cut]` : cut;
      seen.add(entry.sha256);
      used += piece.length;
      included.push(entry.path);
      parts.push(`## ${relative(resolved.repoRoot ?? resolved.cwd, entry.path).split(sep).join('/')}\n${piece}`);
    }
  }
  return { text: parts.join('\n\n'), included, excluded };
}
