import { runProcess, type ProcessRunner } from './process-runner.ts';

/** Result of the read-only repository check; `check-failed` covers timeouts and spawn errors. */
export type GitState = 'repo' | 'not-a-repo' | 'git-not-installed' | 'check-failed';

const CHECK_TIMEOUT_MS = 5000;
/** Variables that could redirect git away from the directory being checked. */
const REDIRECTING_VARIABLES: ReadonlySet<string> = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);

/**
 * Asks git whether `cwd` is inside a work tree (`git rev-parse --is-inside-work-tree`).
 * Strictly read-only: it never initialises, fetches or writes anything.
 */
export async function checkGitRepo(
  cwd: string,
  options: {
    readonly runner?: ProcessRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<GitState> {
  const runner = options.runner ?? runProcess;
  const base = Object.entries(options.env ?? process.env).filter(([key]) => !REDIRECTING_VARIABLES.has(key.toUpperCase()));
  const outcome = await runner({
    command: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    cwd,
    env: { ...Object.fromEntries(base), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: CHECK_TIMEOUT_MS,
    maxOutputBytes: 1024,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  switch (outcome.kind) {
    case 'completed':
      return outcome.exitCode === 0 && outcome.stdout.trim() === 'true' ? 'repo' : 'not-a-repo';
    case 'not-found':
      return 'git-not-installed';
    default:
      return 'check-failed';
  }
}
