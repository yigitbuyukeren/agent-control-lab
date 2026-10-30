import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

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

export type SettingsProblem = 'unreadable' | 'invalid' | 'too-large';

export type SettingsScan =
  | { readonly status: 'clean' }
  | { readonly status: 'unsafe'; readonly findings: readonly SettingsFinding[] }
  /** A settings file exists but cannot be checked, so the run must not proceed. */
  | { readonly status: 'unverifiable'; readonly kind: SettingsKind; readonly problem: SettingsProblem };

const MAX_SETTINGS_BYTES = 256 * 1024;

/** Environment names that could move Claude off the subscription or through another endpoint. */
const UNSAFE_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH', 'CLAUDE_CODE_API_KEY', 'AWS_', 'GOOGLE_', 'CLOUD_ML_', 'VERTEX_'];
const UNSAFE_ENV_NAMES: ReadonlySet<string> = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS',
]);
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
}

/**
 * Where Claude Code may read settings from: user, project, project-local and managed (admin)
 * files. `--restricted` ignores the first three, but managed settings still apply, so every
 * place is checked.
 */
export function settingsLocations(places: SettingsPlaces): SettingsLocation[] {
  const platform = places.platform ?? process.platform;
  const env = places.env ?? process.env;
  const home = places.home ?? homedir();
  const path = platform === 'win32' ? win32 : posix;
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
    { kind: 'project', path: path.join(places.cwd, '.claude', 'settings.json') },
    { kind: 'local', path: path.join(places.cwd, '.claude', 'settings.local.json') },
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

/** Flags the run depends on; a CLI whose own help does not list all of them is not trusted. */
export const REQUIRED_CLAUDE_FLAGS: readonly string[] = [
  '--restricted', '--safe-mode', '--tools', '--strict-mcp-config', '--disable-slash-commands',
  '--no-session-persistence', '--permission-prompts', '--output-format',
];

/** Returns the required flags that `claude --help` does not mention. */
export function missingClaudeFlags(helpText: string, extra: readonly string[] = []): string[] {
  return [...REQUIRED_CLAUDE_FLAGS, ...extra].filter((flag) => !new RegExp(`(^|\\s|,)${flag}(\\s|=|,|$)`, 'm').test(helpText));
}
