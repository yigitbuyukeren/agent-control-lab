import { spawn } from 'node:child_process';

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 5000;

export interface ChainResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Runs the user's own statusLine command exactly as Claude Code would (through the shell), feeding it
 * the same input, so the collector can sit in front of it without changing what the status bar shows.
 */
export function runChained(command: string, input: string, timeoutMs = TIMEOUT_MS): Promise<ChainResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done(1);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout = (stdout + d.toString()).slice(0, MAX_OUTPUT); });
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(0, MAX_OUTPUT); });
    child.on('error', () => { done(1); });
    child.on('close', (code) => { done(code ?? 1); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
