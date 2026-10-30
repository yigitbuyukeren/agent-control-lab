import { claudeRunEnv } from './claude-run.ts';
import { sanitize } from './codex-run.ts';
import type { StepOutcome } from './orchestration.ts';
import { runProcess, type ProcessRunner } from './process-runner.ts';

/** Test runners and build tools accepted for verification. Shells and downloaders are not. */
export const VERIFY_COMMANDS: readonly string[] = [
  'pnpm', 'npm', 'yarn', 'bun', 'deno', 'node', 'pytest', 'python', 'python3', 'cargo', 'go', 'make', 'dotnet', 'mvn', 'gradle', 'swift',
];

export interface VerifyCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const MAX_VERIFY_CHARS = 200;
/** Anything a shell would interpret, plus quoting and expansion characters. */
const FORBIDDEN = /[;&|<>$`"'\\*?(){}[\]!~#\s]/;

/**
 * Parses a verification command given as plain words: `pnpm test`, `cargo test --workspace`.
 * It is never run through a shell, so quoting, pipes, redirects and expansions are rejected
 * instead of interpreted. The executable must be on the allowlist and a bare name.
 */
export function parseVerifyCommand(text: string): VerifyCommand | string {
  if (text.trim() === '' || text.length > MAX_VERIFY_CHARS) return 'the verify command is empty or too long';
  const words = text.trim().split(/ +/);
  if (words.some((w) => w === '' || FORBIDDEN.test(w))) {
    return 'the verify command may only contain plain words (no quotes, pipes, redirects, variables or shell syntax)';
  }
  const [command, ...args] = words;
  if (command === undefined || !VERIFY_COMMANDS.includes(command)) {
    return `the verify command must start with one of: ${VERIFY_COMMANDS.join(', ')}`;
  }
  return { command, args };
}

const MAX_TAIL_CHARS = 2000;

export interface VerifyRequest {
  readonly command: VerifyCommand;
  /** The isolated workspace. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface VerifyDeps {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/**
 * Runs the verification command in the workspace with a cleaned environment (no API keys, tokens
 * or proxy variables) and no shell. It executes code the implementation step just wrote, outside
 * any model sandbox, which is why it is opt-in. Only the exit status and a short output tail are
 * kept; the tail is untrusted text.
 */
export async function runVerify(request: VerifyRequest, deps: VerifyDeps = {}): Promise<StepOutcome> {
  const { command, args } = request.command;
  const outcome = await (deps.runner ?? runProcess)({
    command,
    args: [...args],
    cwd: request.cwd,
    env: claudeRunEnv(deps.env ?? process.env),
    timeoutMs: request.timeoutMs,
    maxOutputBytes: 32 * 1024,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  const label = [command, ...args].join(' ');
  switch (outcome.kind) {
    case 'completed': {
      const tail = sanitize(outcome.stdout).trimEnd().slice(-MAX_TAIL_CHARS);
      const passed = outcome.exitCode === 0;
      const report = `verify command: ${label}\nresult: ${passed ? 'passed' : `failed (exit ${String(outcome.exitCode)})`}\n${tail === '' ? '' : `--- output tail ---\n${tail}\n`}`;
      return passed
        ? { kind: 'completed', output: report, truncated: outcome.truncated }
        : { kind: 'rejected', error: `verification failed (exit ${String(outcome.exitCode)})`, output: report };
    }
    case 'not-found':
      return { kind: 'rejected', error: 'verification command not found' };
    default:
      return { kind: outcome.kind };
  }
}
