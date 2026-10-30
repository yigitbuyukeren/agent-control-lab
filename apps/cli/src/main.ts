import { defaultExec, detectProviders, getInfo, parseCommand, type Exec, type ProviderStatus } from '@agent-control-lab/core';
import { VERSION } from '@agent-control-lab/shared';

const HELP = `agent-control-lab ${VERSION}

Usage: agent-control-lab <command>

Commands:
  help      Show this help
  version   Print the version
  info      Print runtime information
  providers Show installed AI CLI providers (local --version check only)
`;

export interface Io {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

export interface Deps {
  readonly exec?: Exec;
}

function formatProvider(s: ProviderStatus): string {
  const state = s.installed ? `installed${s.version === undefined ? '' : ` ${s.version}`}` : 'not installed';
  return `${s.displayName.padEnd(12)} ${state}${s.error === undefined ? '' : ` (${s.error})`}\n`;
}

export async function run(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    io.error(`${parsed.error}\n\n${HELP}`);
    return 2;
  }
  switch (parsed.value) {
    case 'help':
      io.out(HELP);
      return 0;
    case 'version':
      io.out(`${VERSION}\n`);
      return 0;
    case 'providers': {
      const statuses = await detectProviders(undefined, deps.exec ?? defaultExec);
      io.out(statuses.map(formatProvider).join(''));
      return 0;
    }
    case 'info':
      io.out(
        `${JSON.stringify(getInfo({ node: process.version, platform: process.platform }), null, 2)}\n`,
      );
      return 0;
  }
}
