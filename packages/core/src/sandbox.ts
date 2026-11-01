import { createServer } from 'node:net';
import { access, constants, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runProcess, type ProcessRunner } from './process-runner.ts';

/**
 * OS-level sandbox for the optional verification command. It runs model-written code, so it is wrapped in a
 * profile that allows reading the system, writing only to the worktree and a private temp directory, and no
 * network. Reading a short list of credential locations is denied. This is a deny-list for reads: files outside
 * the list stay readable, which is why the probe and the documentation say so. Nothing here is claimed unless the
 * probe actually passed on this machine.
 */
export interface SandboxWrap {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SandboxProvider {
  readonly name: string;
  wrap(spec: { command: string; args: readonly string[]; cwd: string; tmp: string; protect: readonly string[] }): SandboxWrap;
}

export type SandboxStatus =
  | { readonly available: true; readonly provider: SandboxProvider }
  | { readonly available: false; readonly reason: string };

/** Credential and tool-configuration locations that the sandboxed command may not read. */
export function defaultProtectedPaths(home: string = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.azure', '.kube', '.docker', '.npmrc', '.netrc', '.git-credentials', '.claude', '.codex', '.claude.json', 'Library/Keychains', 'Library/Application Support/Google/Chrome'].map((p) => join(home, p));
}

const sbplString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const macSandbox: SandboxProvider = {
  name: 'macOS sandbox-exec',
  wrap({ command, args, cwd, tmp, protect }) {
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow sysctl-read)',
      '(allow mach-lookup)',
      '(allow ipc-posix-shm)',
      '(allow signal (target self))',
      '(allow file-read*)',
      ...protect.map((p) => `(deny file-read* (subpath ${sbplString(p)}))`),
      `(allow file-write* (subpath ${sbplString(cwd)}) (subpath ${sbplString(tmp)}) (literal "/dev/null") (literal "/dev/dtracehelper"))`,
      ...protect.map((p) => `(deny file-write* (subpath ${sbplString(p)}))`),
      '(deny network*)',
    ].join('\n');
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] };
  },
};

export const bwrapSandbox: SandboxProvider = {
  name: 'bubblewrap',
  wrap({ command, args, cwd, tmp, protect }) {
    return {
      command: 'bwrap',
      args: [
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--bind', cwd, cwd, '--bind', tmp, tmp,
        ...protect.flatMap((p) => ['--tmpfs', p]),
        '--unshare-net', '--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session',
        '--chdir', cwd, '--', command, ...args,
      ],
    };
  },
};

export interface DetectDeps {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly pathEnv?: string | undefined;
}

const canExecute = (path: string): Promise<boolean> => access(path, constants.X_OK).then(() => true, () => false);

/** Finds a sandbox mechanism that exists here. It says nothing about whether it works; run `probeSandbox` for that. */
export async function detectSandbox(deps: DetectDeps = {}): Promise<SandboxStatus> {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? canExecute;
  if (platform === 'darwin') {
    return (await exists('/usr/bin/sandbox-exec')) ? { available: true, provider: macSandbox } : { available: false, reason: 'sandbox-exec was not found' };
  }
  if (platform === 'linux') {
    for (const dir of (deps.pathEnv ?? process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')) {
      if (await exists(join(dir, 'bwrap'))) return { available: true, provider: bwrapSandbox };
    }
    return { available: false, reason: 'bubblewrap (bwrap) is not installed' };
  }
  if (platform === 'win32') return { available: false, reason: 'Windows has no supported OS sandbox here; use WSL2 with bubblewrap or run the tests yourself' };
  return { available: false, reason: `no sandbox support for ${platform}` };
}

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function runWrapped(provider: SandboxProvider, command: string, args: readonly string[], cwd: string, tmp: string, protect: readonly string[], runner: ProcessRunner): Promise<number | 'error'> {
  const wrapped = provider.wrap({ command, args, cwd, tmp, protect });
  const out = await runner({ command: wrapped.command, args: wrapped.args, cwd, env: { PATH: process.env['PATH'], TMPDIR: tmp }, timeoutMs: 20_000, maxOutputBytes: 4096 });
  return out.kind === 'completed' && out.exitCode !== null ? out.exitCode : 'error';
}

/**
 * Proves the sandbox works on this machine: writing inside the worktree must succeed, writing elsewhere, reading a
 * protected file and connecting to a local TCP listener must all fail. Any other result means "no sandbox".
 */
export async function probeSandbox(provider: SandboxProvider, runner: ProcessRunner = runProcess): Promise<ProbeResult> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'acl-probe-')));
  const work = join(base, 'work');
  const tmp = join(base, 'tmp');
  const outside = join(base, 'outside');
  const secret = join(base, 'secret');
  const server = createServer();
  try {
    await Promise.all([work, tmp, outside, secret].map((d) => mkdir(d)));
    await writeFile(join(secret, 'key'), 'top secret');
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
    const sh = (script: string): [string, string[]] => ['/bin/sh', ['-c', script]];
    const protect = [secret];
    const run = (spec: [string, string[]]) => runWrapped(provider, spec[0], spec[1], work, tmp, protect, runner);
    const inside = await run(sh(`echo ok > "${join(work, 'probe.txt')}"`));
    if (inside !== 0 || (await readFile(join(work, 'probe.txt'), 'utf8').catch(() => '')).trim() !== 'ok') return { ok: false, reason: 'the sandbox does not let the command write inside the worktree' };
    if ((await run(sh(`echo bad > "${join(outside, 'x.txt')}"`))) === 0 || (await readFile(join(outside, 'x.txt'), 'utf8').catch(() => '')) !== '') return { ok: false, reason: 'the sandbox did not stop a write outside the worktree' };
    if ((await run(sh(`cat "${join(secret, 'key')}" > /dev/null`))) === 0) return { ok: false, reason: 'the sandbox did not stop reading a protected file' };
    const connect = `const s=require("net").connect(${String(port)},"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(3),3000)`;
    if ((await run([process.execPath, ['-e', connect]])) === 0) return { ok: false, reason: 'the sandbox did not block network access' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'the sandbox probe could not run' };
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
}

export type SandboxDecision =
  | { readonly mode: 'sandboxed'; readonly provider: SandboxProvider }
  | { readonly mode: 'unavailable'; readonly reason: string };

/** Detect, then prove. Anything short of a passed probe is `unavailable`. */
export async function resolveSandbox(deps: DetectDeps & { readonly runner?: ProcessRunner } = {}): Promise<SandboxDecision> {
  const found = await detectSandbox(deps);
  if (!found.available) return { mode: 'unavailable', reason: found.reason };
  const probe = await probeSandbox(found.provider, deps.runner);
  return probe.ok ? { mode: 'sandboxed', provider: found.provider } : { mode: 'unavailable', reason: `${found.provider.name} is installed but failed its check: ${probe.reason}` };
}
