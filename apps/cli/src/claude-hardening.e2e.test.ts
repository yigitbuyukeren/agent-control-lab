import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../bin/agent-control-lab.js', import.meta.url));
const windows = process.platform === 'win32';
const ALL_FLAGS = ['--restricted', '--safe-mode', '--tools <tools...>', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts <target>', '--output-format <format>', '--model <model>', '--effort <level>'];
const SUBSCRIPTION = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', email: 'me@example.com' };
const SECRET_VALUES = ['sk-ant-SECRET', 'evil.example', 'steal.sh', 'proxy.example'];

// Fake `claude`: behaviour comes from mode.json next to it (the run's environment is cleaned,
// so test switches cannot travel through env). No model is ever contacted.
const FAKE = `
const fs = require('node:fs');
const path = require('node:path');
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(mode.version + ' (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(mode.help.join('\\n')); process.exit(0); }
if (args[0] === 'auth') {
  // The probe must run in the cleaned environment: a leaked key would flip the login method.
  console.log(JSON.stringify(process.env.ANTHROPIC_API_KEY ? { loggedIn: true, authMethod: 'api_key' } : mode.auth));
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const leaked = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE|AWS_|OPENAI_)/i.test(k) && k !== 'CLAUDE_CONFIG_DIR');
  fs.writeFileSync(path.join(process.cwd(), 'ran.marker'), JSON.stringify({ args, stdin, leaked }));
  console.log('FAKE-ANSWER');
});
`;

let root = '';
let bin = '';
let cfg = '';
let home = '';
let proj = '';

function setMode(over: Partial<{ help: string[]; version: string; auth: object }> = {}): void {
  writeFileSync(join(bin, 'mode.json'), JSON.stringify({ help: ALL_FLAGS, version: '2.1.312', auth: SUBSCRIPTION, ...over }));
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'acl hardening ')));
  bin = join(root, 'bin');
  cfg = join(root, 'config');
  home = join(root, 'home');
  for (const d of [bin, cfg, home]) mkdirSync(d);
  writeFileSync(join(bin, 'fake-claude.js'), FAKE);
  const file = join(bin, windows ? 'claude.cmd' : 'claude');
  writeFileSync(file, windows ? `@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "${join(bin, 'fake-claude.js')}" "$@"\n`);
  chmodSync(file, 0o755);
});

beforeEach(() => {
  proj = join(root, `proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(proj, '.claude'), { recursive: true });
  for (const f of ['settings.json']) rmSync(join(cfg, f), { force: true });
  setMode();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
  }
  env['PATH'] = [bin, process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter);
  Object.assign(env, { CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home }, extraEnv);
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const START = () => ['run', '--provider', 'claude', '--task', 'summarize', '--cwd', proj, '--confirm'];
const marker = () => (existsSync(join(proj, 'ran.marker')) ? (JSON.parse(readFileSync(join(proj, 'ran.marker'), 'utf8')) as { args: string[]; stdin: string; leaked: string[] }) : undefined);
const noSecrets = (text: string) => {
  for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  expect(text).not.toContain('me@example.com');
};

describe('Claude runner hardening against a fake CLI', () => {
  it('runs with restricted + safe mode, even when the caller environment is dirty', () => {
    const dirty = { ANTHROPIC_API_KEY: 'sk-ant-SECRET', ANTHROPIC_BASE_URL: 'https://proxy.example', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'tok', AWS_ACCESS_KEY_ID: 'a' };
    const r = runCli(START(), dirty);
    expect(r.stderr).not.toContain('refused');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('FAKE-ANSWER');
    const ran = marker();
    expect(ran?.args).toEqual(expect.arrayContaining(['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
    expect(ran?.args[ran.args.indexOf('--tools') + 1]).toBe('');
    expect(ran?.stdin).toBe('summarize');
    expect(ran?.leaked).toEqual([]);
    noSecrets(r.stdout + r.stderr);
  });

  it('refuses dirty user settings env, naming keys but never values, without starting claude', () => {
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET', HTTPS_PROXY: 'http://evil.example:8080' } }));
    const r = runCli(START());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('run refused: a Claude settings file sets credentials, a provider, a proxy or a login helper');
    expect(r.stderr).toContain('finding: user settings env.ANTHROPIC_API_KEY');
    expect(r.stderr).toContain('finding: user settings env.HTTPS_PROXY');
    noSecrets(r.stdout + r.stderr);
    expect(marker()).toBeUndefined();
  });

  it('refuses dirty project and local settings, and a login helper', () => {
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/tmp/steal.sh' }));
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }));
    const r = runCli(START());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('finding: project settings apiKeyHelper');
    expect(r.stderr).toContain('finding: local settings env.CLAUDE_CODE_USE_VERTEX');
    noSecrets(r.stdout + r.stderr);
    expect(marker()).toBeUndefined();
  });

  it('fails closed on a settings file it cannot parse, even with --accept-unverified', () => {
    writeFileSync(join(proj, '.claude', 'settings.json'), '{ "env": { broken');
    for (const extra of [[], ['--accept-unverified']]) {
      const r = runCli([...START(), ...extra]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('could not be read or parsed');
      expect(r.stderr).toContain('settings: project file is invalid');
      expect(marker()).toBeUndefined();
    }
  });

  it('fails closed when the CLI help lacks a required safety flag', () => {
    setMode({ help: ALL_FLAGS.filter((f) => !f.startsWith('--restricted')) });
    const r = runCli(START());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('did not list every safety flag');
    expect(marker()).toBeUndefined();
  });

  it('rejects ultracode for an unreadable CLI version and accepts it for a verified one', () => {
    setMode({ version: 'garbled' });
    const denied = runCli([...START(), '--mode', 'ultracode', '--accept-unverified']);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('version could not be read or parsed, which ultracode requires');
    expect(marker()).toBeUndefined();
    setMode({ version: '2.1.312' });
    const ok = runCli([...START(), '--mode', 'ultracode', '--accept-unverified']);
    expect(ok.code).toBe(0);
    const args = marker()?.args ?? [];
    expect(args.slice(args.indexOf('--effort'))).toEqual(['--effort', 'ultracode']);
  });

  it('still refuses API-key, third-party and non-subscription logins before anything else', () => {
    for (const auth of [{ loggedIn: true, authMethod: 'api_key' }, { ...SUBSCRIPTION, apiProvider: 'bedrock' }, { ...SUBSCRIPTION, subscriptionType: 'free' }]) {
      setMode({ auth });
      const r = runCli(START());
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('run refused: claude');
      expect(marker()).toBeUndefined();
    }
  });

  it('dry-run reports the checks without values and without starting claude', () => {
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example' } }));
    const r = runCli(['run', '--provider', 'claude', '--task', 'summarize', '--cwd', proj, '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('restricted: on');
    expect(r.stdout).toContain('flags check: ok');
    expect(r.stdout).toContain('settings check: unsafe');
    expect(r.stdout).toContain('finding: user settings env.ANTHROPIC_BASE_URL');
    noSecrets(r.stdout + r.stderr);
    expect(marker()).toBeUndefined();
  });

  it('names Claude in the missing --confirm error', () => {
    const r = runCli(['run', '--provider', 'claude', '--task', 'x', '--cwd', proj]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Claude session');
    expect(r.stderr).not.toContain('Codex');
  });
});
