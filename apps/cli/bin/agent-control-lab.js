#!/usr/bin/env node
import { run } from '../src/main.ts';

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  error: (text) => process.stderr.write(text),
});
