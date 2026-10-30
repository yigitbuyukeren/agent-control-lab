import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { ProcessRunner } from './process-runner.ts';
import { discoverRepoRoots, projectSettingsDirs, realCwd } from './repo-roots.ts';

export type SettingsKind = 'user' | 'project' | 'local' | 'managed';

export interface SettingsLocation {
  readonly kind: SettingsKind;
  readonly path: string;
}

/** A dangerous key found in a settings file. Only the key name is kept, never its value. */
export interface SettingsFinding {
  readonly kind: SettingsKind;
  readonly key: string;
}

/** `repo-unresolved`: the repository layout could not be established, so project places are unknown. */
export type SettingsProblem = 'unreadable' | 'invalid' | 'too-large' | 'repo-unresolved';

/**
 * What the file scan cannot see. Managed policy can also come from MDM (macOS profiles, Windows
 * registry/GPO) or from the server (remote managed settings, organisation policy); none of that
 * is readable here, so a clean scan never proves the active policy is safe.
 */
export const MANAGED_POLICY_LIMIT =
  'file scan only: MDM/registry and server-managed (remote) policy are not covered, so the active managed policy is unverified';

export type SettingsScan =
  | { readonly status: 'clean' }
  | { readonly status: 'unsafe'; readonly findings: readonly SettingsFinding[] }
  /** A settings file exists but cannot be checked, so the run must not proceed. */
  | { readonly status: 'unverifiable'; readonly kind: SettingsKind; readonly problem: SettingsProblem };

const MAX_SETTINGS_BYTES = 256 * 1024;

/** Environment names that could move Claude off the subscription or through another endpoint. */
const UNSAFE_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH', 'CLAUDE_CODE_API_KEY', 'AWS_', 'GOOGLE_', 'CLOUD_ML_', 'VERTEX_'];
/** Proxy and TLS names that can send the connection somewhere else or change who is trusted. */
const NETWORK_ENV_NAMES: ReadonlySet<string> = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);
const UNSAFE_ENV_NAMES: ReadonlySet<string> = new Set([...NETWORK_ENV_NAMES, 'NODE_OPTIONS']);

/**
 * Names (never values) in `env` that would redirect the connection or the login if forwarded:
 * proxy/TLS variables and any base-URL or cloud-provider switch.
 */
export function redirectingEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => {
      if (value === undefined || value === '') return false;
      const name = key.toUpperCase();
      return NETWORK_ENV_NAMES.has(name) || name.startsWith('ANTHROPIC_BASE') || name.startsWith('CLAUDE_CODE_USE_');
    })
    .map(([key]) => key.toUpperCase())
    .sort();
}
/** Top-level settings that run helpers or force a login method. */
const UNSAFE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'apikeyhelper', 'awsauthrefresh', 'awscredentialexport', 'forceloginmethod',
]);

export function isUnsafeEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return UNSAFE_ENV_NAMES.has(upper) || UNSAFE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface SettingsPlaces {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Directories whose `.claude` project files apply (see `projectSettingsDirs`); defaults to `[cwd]`. */
  readonly projectDirs?: readonly string[];
}

/**
 * Where Claude Code may read settings from: user, project, project-local and managed (admin)
 * files. Project and local files are checked in every directory from the working directory up to
 * the repository root, plus the main worktree root, because the observed resolution (local
 * settings from the repository root, project settings relative to the directory) is not
 * guaranteed. `--restricted` ignores the first three, but managed settings still apply, so every
 * place is checked. Only managed *files* are listed; see `MANAGED_POLICY_LIMIT`.
 */
export function settingsLocations(places: SettingsPlaces): SettingsLocation[] {
  const platform = places.platform ?? process.platform;
  const env = places.env ?? process.env;
  const home = places.home ?? homedir();
  const path = platform === 'win32' ? win32 : posix;
  const dirs = places.projectDirs ?? [places.cwd];
  const configured = env['CLAUDE_CONFIG_DIR'];
  const userDir = configured !== undefined && configured !== '' ? configured : path.join(home, '.claude');
  const managed =
    platform === 'win32'
      ? [win32.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')]
      : platform === 'darwin'
        ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
        : ['/etc/claude-code/managed-settings.json'];
  return [
    { kind: 'user', path: path.join(userDir, 'settings.json') },
    ...dirs.flatMap((dir): SettingsLocation[] => [
      { kind: 'project', path: path.join(dir, '.claude', 'settings.json') },
      { kind: 'local', path: path.join(dir, '.claude', 'settings.local.json') },
    ]),
    ...managed.map((p): SettingsLocation => ({ kind: 'managed', path: p })),
  ];
}

type FileRead = { readonly state: 'missing' } | { readonly state: 'ok'; readonly text: string } | { readonly state: SettingsProblem };

async function readSettingsFile(path: string): Promise<FileRead> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { state: 'unreadable' };
    if (info.size > MAX_SETTINGS_BYTES) return { state: 'too-large' };
    return { state: 'ok', text: await readFile(path, 'utf8') };
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'missing' } : { state: 'unreadable' };
  }
}

function inspect(kind: SettingsKind, text: string): SettingsFinding[] | 'invalid' {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'invalid';
  const record = data as Record<string, unknown>;
  const findings: SettingsFinding[] = [];
  for (const key of Object.keys(record)) {
    if (UNSAFE_SETTING_KEYS.has(key.toLowerCase())) findings.push({ kind, key });
  }
  const env = record['env'];
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return 'invalid';
    for (const name of Object.keys(env)) {
      if (isUnsafeEnvName(name)) findings.push({ kind, key: `env.${name}` });
    }
  }
  return findings;
}

/**
 * Read-only check of every settings place. Fails closed: a file that exists but cannot be
 * read or parsed makes the scan `unverifiable`. Values are never returned or logged.
 */
export async function scanClaudeSettings(
  locations: readonly SettingsLocation[],
): Promise<SettingsScan> {
  const findings: SettingsFinding[] = [];
  for (const location of locations) {
    const file = await readSettingsFile(location.path);
    if (file.state === 'missing') continue;
    if (file.state !== 'ok') return { status: 'unverifiable', kind: location.kind, problem: file.state };
    const result = inspect(location.kind, file.text);
    if (result === 'invalid') return { status: 'unverifiable', kind: location.kind, problem: 'invalid' };
    findings.push(...result);
  }
  return findings.length === 0 ? { status: 'clean' } : { status: 'unsafe', findings };
}

/**
 * Scans every settings place for `cwd`, using read-only git to find the repository root and any
 * main worktree. If git cannot say where the repository is, the scan is `unverifiable` rather
 * than limited to the working directory.
 */
export async function scanClaudeSettingsFor(
  cwd: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
    readonly runner?: ProcessRunner;
  } = {},
): Promise<SettingsScan> {
  const real = await realCwd(cwd);
  const unresolved: SettingsScan = { status: 'unverifiable', kind: 'project', problem: 'repo-unresolved' };
  if (real === undefined) return unresolved;
  const roots = await discoverRepoRoots(real, {
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const projectDirs = projectSettingsDirs(real, roots, options.platform);
  if (projectDirs === undefined) return unresolved;
  return scanClaudeSettings(
    settingsLocations({
      cwd: real,
      projectDirs,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.home === undefined ? {} : { home: options.home }),
    }),
  );
}

/** Flags the run depends on; a CLI whose own help does not list all of them is not trusted. */
export const REQUIRED_CLAUDE_FLAGS: readonly string[] = [
  '--restricted', '--safe-mode', '--tools', '--strict-mcp-config', '--disable-slash-commands',
  '--no-session-persistence', '--permission-prompts', '--output-format',
];

/** Returns the required flags that `claude --help` does not mention. */
export function missingClaudeFlags(helpText: string, extra: readonly string[] = []): string[] {
  return [...REQUIRED_CLAUDE_FLAGS, ...extra].filter((flag) => !new RegExp(`(^|\\s|,)${flag}(\\s|=|,|$)`, 'm').test(helpText));
}
