#!/usr/bin/env node
import { run } from '../src/main.ts';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  // First signal cancels cleanly (child processes are stopped); a second one exits at once.
  process.once(signal, () => {
    controller.abort();
    process.once(signal, () => process.exit(130));
  });
}

process.exitCode = await run(
  process.argv.slice(2),
  {
    out: (text) => process.stdout.write(text),
    error: (text) => process.stderr.write(text),
  },
  { signal: controller.signal },
);
