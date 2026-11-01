// Builds the distributable package: release/agent-control-lab-<version>.tgz (npm pack format; nothing is published).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = readFileSync(join(root, 'packages/shared/src/index.ts'), 'utf8');
const version = /VERSION = '([^']+)'/.exec(shared)?.[1];
if (version === undefined) throw new Error('VERSION not found');
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const stage = join(root, 'release', 'package');
rmSync(join(root, 'release'), { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });
copyFileSync(join(root, 'dist/agent-control-lab.js'), join(stage, 'bin/agent-control-lab.js'));
for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) copyFileSync(join(root, f), join(stage, f));
mkdirSync(join(stage, 'docs'));
for (const f of readdirSync(join(root, 'docs'))) {
  if (f.endsWith('.md')) cpSync(join(root, 'docs', f), join(stage, 'docs', f));
}
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agent-control-lab',
      version,
      description: 'Local control plane for the original Claude Code and Codex CLIs: instructions, handoff, worktrees, sandboxed checks, quota and model routing.',
      license: 'MIT',
      type: 'module',
      bin: { 'agent-control-lab': 'bin/agent-control-lab.js' },
      files: ['bin', 'docs', 'README.md', 'LICENSE', 'CHANGELOG.md'],
      engines: { node: '>=24' },
      repository: { type: 'git', url: 'git+https://github.com/yigitbuyukeren/agent-control-lab.git' },
      keywords: ['claude-code', 'codex', 'cli', 'agents', 'worktree'],
    },
    null,
    2,
  )}\n`,
);
execFileSync('npm', ['pack', '--pack-destination', join(root, 'release'), '--silent'], { cwd: stage, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
const tgz = readdirSync(join(root, 'release')).find((f) => f.endsWith('.tgz'));
const sha = createHash('sha256').update(readFileSync(join(root, 'release', tgz))).digest('hex');
writeFileSync(join(root, 'release', `${tgz}.sha256`), `${sha}  ${tgz}\n`);
console.log(`${tgz}\nsha256 ${sha}`);
