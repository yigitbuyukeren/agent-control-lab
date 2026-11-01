// Bundles the CLI (and its workspace packages) into one dependency-free ES module: dist/agent-control-lab.js
import { build } from 'esbuild';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist', 'agent-control-lab.js');
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [resolve(root, 'apps/cli/bin/agent-control-lab.js')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});
chmodSync(out, 0o755);
console.log(`built ${out}`);
