// Installs the packed tarball into an empty directory (no repository, no workspace) and runs it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tgz = readdirSync(join(root, 'release')).find((f) => f.endsWith('.tgz'));
if (tgz === undefined) throw new Error('run pnpm pack:release first');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'acl smoke ')));
const win = process.platform === 'win32';
const env = { ...process.env, ACL_CACHE_DIR: join(base, 'cache') };
const npm = (...args) => execFileSync('npm', args, { cwd: base, encoding: 'utf8', shell: win, env });
npm('init', '-y', '--silent');
npm('install', '--silent', '--no-audit', '--no-fund', join(root, 'release', tgz));
const entry = join(base, 'node_modules', 'agent-control-lab', 'bin', 'agent-control-lab.js');
const run = (...args) => execFileSync(process.execPath, [entry, ...args], { cwd: base, encoding: 'utf8', env });
const fail = (msg) => {
  console.error(`smoke failed: ${msg}`);
  process.exit(1);
};
const installed = JSON.parse(readFileSync(join(base, 'node_modules', 'agent-control-lab', 'package.json'), 'utf8'));
if (run('version').trim() !== installed.version) fail('version mismatch');
if (!run('help').includes('instructions')) fail('help is missing commands');
const project = join(base, 'proj');
mkdirSync(join(project, '.git'), { recursive: true });
writeFileSync(join(project, 'AGENTS.md'), 'be brief');
if (!run('instructions', '--cwd', project, '--provider', 'codex').includes('AGENTS.md')) fail('instructions did not list AGENTS.md');
if (!run('workspaces', '--root', base).includes('candidates')) fail('workspaces failed');
if (!run('tasks').includes('no recorded tasks')) fail('tasks failed');
if (existsSync(join(base, 'node_modules', 'agent-control-lab', 'src'))) fail('package unexpectedly ships sources');
console.log(`smoke ok: agent-control-lab ${installed.version} installed from ${tgz} and ran outside the repository`);
