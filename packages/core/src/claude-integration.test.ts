import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeClaudeCache } from './claude-cache.ts';
import {
  collectorCommand,
  decodeChain,
  diagnoseClaudeIntegration,
  INSTALL_RECORD,
  installCollector,
  uninstallCollector,
  type IntegrationPaths,
} from './claude-integration.ts';

let root = '';
let paths: IntegrationPaths;
const NOW = new Date('2026-10-31T12:00:00.000Z');
const windows = process.platform === 'win32';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'acl integration '));
  await mkdir(join(root, 'claude'));
  paths = { settingsPath: join(root, 'claude', 'settings.json'), cacheDir: join(root, 'cache'), nodePath: '/usr/bin/node', binPath: '/opt/acl/bin/agent-control-lab.js' };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeSettings = (value: unknown) => writeFile(paths.settingsPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const readSettings = async () => JSON.parse(await readFile(paths.settingsPath, 'utf8')) as Record<string, unknown>;
const freshCache = (minutesAgo = 1) =>
  writeClaudeCache(
    paths.cacheDir ?? '',
    { state: 'ok', fiveHour: { windowMinutes: 300, usedPercent: 42, resetsAt: '2026-10-31T15:00:00.000Z' }, sevenDay: { windowMinutes: 10080, usedPercent: 7, resetsAt: '2026-11-05T00:00:00.000Z' } },
    new Date(NOW.getTime() - minutesAgo * 60_000),
  );

describe('collector command', () => {
  it('quotes the paths, uses forward slashes and refuses characters it cannot quote', () => {
    expect(collectorCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\acl\\bin\\a.js')).toBe('"C:/Program Files/nodejs/node.exe" "C:/acl/bin/a.js" statusline-collect');
    expect(collectorCommand('/n', '/a"b')).toBeUndefined();
    expect(collectorCommand('/n', '/a$b')).toBeUndefined();
  });
  it('round-trips a chained command without quoting trouble', () => {
    const original = `./my-line.sh --label "a b" 'x' $HOME`;
    const command = collectorCommand('/n', '/a', original) ?? '';
    expect(command).toMatch(/statusline-collect --chain [A-Za-z0-9_-]+$/);
    expect(decodeChain(command.split(' --chain ')[1])).toBe(original);
    expect(decodeChain('***')).toBeUndefined();
    expect(decodeChain(undefined)).toBeUndefined();
  });
});

describe('diagnosis explains why there is no data', () => {
  it('not installed when the settings file is missing or has no statusLine', async () => {
    expect((await diagnoseClaudeIntegration(paths, NOW)).reason).toBe('not-installed');
    await writeSettings({ theme: 'dark' });
    const d = await diagnoseClaudeIntegration(paths, NOW);
    expect(d).toMatchObject({ settings: 'no-statusline', reason: 'not-installed', installed: false, plan: { action: 'add' } });
  });
  it('another statusLine: plan is to chain; unsupported shape and unparsable file block the plan', async () => {
    await writeSettings({ statusLine: { type: 'command', command: './mine.sh' } });
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ settings: 'other', reason: 'other-statusline', plan: { action: 'chain' } });
    await writeSettings({ statusLine: 'text' });
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ reason: 'unsupported-statusline', planBlocked: 'unsupported' });
    await writeSettings('{ // comment\n "a": 1 }');
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ settings: 'invalid', reason: 'settings-invalid', planBlocked: 'invalid' });
  });
  it('installed but empty cache waits for data; fresh, stale, expired and broken caches are told apart', async () => {
    await writeSettings({ statusLine: { type: 'command', command: '"/n" "/a" statusline-collect' } });
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ installed: true, reason: 'waiting-for-data', planBlocked: 'already-installed' });
    await freshCache(1);
    const fresh = await diagnoseClaudeIntegration(paths, NOW);
    expect(fresh).toMatchObject({ reason: 'fresh', cache: { state: 'fresh', ageSeconds: 60 } });
    expect(fresh.fiveHour?.usedPercent).toBe(42);
    expect(fresh.sevenDay?.resetsAt).toBe('2026-11-05T00:00:00.000Z');
    await freshCache(40);
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ reason: 'stale', cache: { state: 'stale' } });
    expect((await diagnoseClaudeIntegration(paths, NOW)).fiveHour).toBeUndefined();
    await writeClaudeCache(paths.cacheDir ?? '', { state: 'ok', fiveHour: { windowMinutes: 300, usedPercent: 9, resetsAt: '2026-10-31T11:30:00.000Z' } }, new Date(NOW.getTime() - 60_000));
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ reason: 'windows-expired' });
    await writeFile(join(paths.cacheDir ?? '', 'claude-quota.json'), '{nope');
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ reason: 'cache-invalid' });
  });
  it('says so when there is no cache directory', async () => {
    expect(await diagnoseClaudeIntegration({ ...paths, cacheDir: undefined }, NOW)).toMatchObject({ reason: 'no-cache-dir', planBlocked: 'no-cache-dir' });
  });
});

describe('install and uninstall', () => {
  it('adds a statusLine, keeps every other key, and restores the file content exactly on undo', async () => {
    await writeSettings({ theme: 'dark', permissions: { allow: ['Read'] } });
    expect(await installCollector(paths, NOW)).toEqual({ ok: true, action: 'add' });
    const after = await readSettings();
    expect(after['theme']).toBe('dark');
    expect(after['permissions']).toEqual({ allow: ['Read'] });
    expect(after['statusLine']).toEqual({ type: 'command', command: '"/usr/bin/node" "/opt/acl/bin/agent-control-lab.js" statusline-collect' });
    expect((await diagnoseClaudeIntegration(paths, NOW)).restorable).toBe(true);
    expect(await installCollector(paths, NOW)).toEqual({ ok: true, action: 'unchanged' });
    expect(await uninstallCollector(paths)).toEqual({ ok: true });
    expect(await readSettings()).toEqual({ theme: 'dark', permissions: { allow: ['Read'] } });
    await expect(stat(join(paths.cacheDir ?? '', INSTALL_RECORD))).rejects.toThrow();
  });
  it('creates the settings file when there is none, and removes the key again on undo', async () => {
    expect(await installCollector(paths, NOW)).toEqual({ ok: true, action: 'add' });
    expect((await readSettings())['statusLine']).toBeDefined();
    expect(await uninstallCollector(paths)).toEqual({ ok: true });
    expect(await readSettings()).toEqual({});
  });
  it('chains an existing command instead of replacing it, keeps its other fields, and undoes to the original', async () => {
    const original = { type: 'command', command: `./mine.sh --token sk-abcdefghijklmnop`, padding: 2 };
    await writeSettings({ model: 'x', statusLine: original });
    expect(await installCollector(paths, NOW)).toEqual({ ok: true, action: 'chain' });
    const line = (await readSettings())['statusLine'] as { command: string; padding: number };
    expect(line.padding).toBe(2);
    expect(decodeChain(line.command.split(' --chain ')[1])).toBe(original.command);
    expect(await diagnoseClaudeIntegration(paths, NOW)).toMatchObject({ settings: 'chained', installed: true });
    expect(await uninstallCollector(paths)).toEqual({ ok: true });
    expect(await readSettings()).toEqual({ model: 'x', statusLine: original });
  });
  it('refuses to undo when the user changed statusLine since, and leaves the file alone', async () => {
    await writeSettings({});
    await installCollector(paths, NOW);
    await writeSettings({ statusLine: { type: 'command', command: 'something else' } });
    const before = await readFile(paths.settingsPath, 'utf8');
    expect(await uninstallCollector(paths)).toEqual({ ok: false, reason: 'changed-since-install' });
    expect(await readFile(paths.settingsPath, 'utf8')).toBe(before);
  });
  it('has nothing to undo without a record', async () => {
    await writeSettings({ statusLine: { type: 'command', command: '"/n" "/a" statusline-collect' } });
    expect(await uninstallCollector(paths)).toEqual({ ok: false, reason: 'no-record' });
  });
  it('never rewrites a file it cannot parse exactly, an unsupported statusLine, or an unquotable path', async () => {
    const jsonc = '{\n  // keep me\n  "a": 1\n}\n';
    await writeSettings(jsonc);
    expect(await installCollector(paths, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await readFile(paths.settingsPath, 'utf8')).toBe(jsonc);
    await writeSettings({ statusLine: 5 });
    expect(await installCollector(paths, NOW)).toEqual({ ok: false, reason: 'unsupported' });
    await writeSettings({});
    expect(await installCollector({ ...paths, binPath: '/a"b' }, NOW)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await installCollector({ ...paths, cacheDir: undefined }, NOW)).toEqual({ ok: false, reason: 'no-cache-dir' });
    expect(await readSettings()).toEqual({});
  });
  it.skipIf(windows)('keeps the settings file mode', async () => {
    await writeSettings({});
    await chmod(paths.settingsPath, 0o640);
    await installCollector(paths, NOW);
    expect((await stat(paths.settingsPath)).mode & 0o777).toBe(0o640);
  });
});
