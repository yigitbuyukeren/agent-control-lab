import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseInstructionsArgs, runInstructionsCommand } from './instructions-cmd.ts';
import { run } from './main.ts';

describe('instructions command', () => {
  it('validates arguments', () => {
    expect(parseInstructionsArgs([])).toContain('--cwd is required');
    expect(parseInstructionsArgs(['--cwd', '.', '--provider', 'x'])).toContain('--provider');
    expect(parseInstructionsArgs(['--cwd', '.', '--bogus'])).toContain('unknown option');
  });

  it('prints project files and the exportable context as JSON, without touching files', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'acl cmd ')));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'CLAUDE.md'), 'Use pnpm.');
    const out: string[] = [];
    const code = await runInstructionsCommand({ cwd: root, provider: 'claude', context: true, json: true }, { out: (t) => out.push(t), error: () => undefined });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('')) as { claude: { entries: { path: string }[] }; context: { text: string } };
    expect(parsed.claude.entries.some((e) => e.path === join(root, 'CLAUDE.md'))).toBe(true);
    expect(parsed.context.text).toContain('Use pnpm.');
  });

  it('is reachable through run() and rejects bad input with exit code 2', async () => {
    const errors: string[] = [];
    expect(await run(['instructions'], { out: () => undefined, error: (t) => errors.push(t) })).toBe(2);
    expect(errors.join('')).toContain('--cwd');
  });
});
