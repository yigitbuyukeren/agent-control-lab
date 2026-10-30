import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess, type ProcessSpec } from './process-runner.ts';

let dir = '';
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'acl proc ')));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const node = (script: string, extra: Partial<ProcessSpec> = {}, args: string[] = []): ProcessSpec => ({
  command: 'node',
  args: ['-e', script, ...args],
  cwd: dir,
  env: process.env,
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  ...extra,
});

async function waitDead(pidFile: string): Promise<boolean> {
  for (let i = 0; i < 60 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 60; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('runProcess', () => {
  it('passes stdin, an explicit cwd and shell-looking args literally (no shell)', async () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),d})))';
    const out = await runProcess(node(script, { input: 'hello & world' }, ['a&b', '$(id)', ';x', 'two words']));
    expect(out.kind).toBe('completed');
    if (out.kind !== 'completed') return;
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { cwd: string; args: string[]; d: string };
    expect(realpathSync(parsed.cwd)).toBe(dir);
    expect(parsed.args).toEqual(['a&b', '$(id)', ';x', 'two words']);
    expect(parsed.d).toBe('hello & world');
  });

  it('reports exit codes and never captures stderr', async () => {
    const out = await runProcess(node('console.error("SECRET-ERR");console.log("ok");process.exit(3)'));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 3 });
    expect(out.kind === 'completed' && out.stdout).toBe('ok\n');
  });

  it('bounds output and reports truncation', async () => {
    const out = await runProcess(node('process.stdout.write("x".repeat(300000))', { maxOutputBytes: 1024 }));
    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.stdout.length).toBe(1024);
      expect(out.truncated).toBe(true);
    }
  });

  it('times out and kills the process', async () => {
    const pidFile = join(dir, 'timeout.pid');
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    expect(await runProcess(node(script, { timeoutMs: 500 }))).toEqual({ kind: 'timeout' });
    expect(await waitDead(pidFile)).toBe(true);
  });

  it('cancels through an AbortSignal and kills the whole process tree', async () => {
    const parentPid = join(dir, 'tree-parent.pid');
    const childPid = join(dir, 'tree-child.pid');
    const child = `require("fs").writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000)`;
    const script = `require("fs").writeFileSync(${JSON.stringify(parentPid)},String(process.pid));require("child_process").spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const running = runProcess(node(script, { signal: controller.signal }));
    for (let i = 0; i < 80 && !(existsSync(parentPid) && existsSync(childPid)); i += 1) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    expect(await running).toEqual({ kind: 'cancelled' });
    expect(await waitDead(parentPid)).toBe(true);
    expect(await waitDead(childPid)).toBe(true);
  });

  it('does not start anything when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const pidFile = join(dir, 'never.pid');
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)},"1")`;
    expect(await runProcess(node(script, { signal: controller.signal }))).toEqual({ kind: 'cancelled' });
    expect(existsSync(pidFile)).toBe(false);
  });

  it('maps a missing command to not-found', async () => {
    expect(await runProcess({ ...node(''), command: 'acl-definitely-missing-cli', args: [] })).toEqual({ kind: 'not-found' });
  });
});
