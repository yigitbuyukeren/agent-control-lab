import { VERSION, err, ok, type Result } from '@agent-control-lab/shared';

export interface LabInfo {
  readonly name: string;
  readonly version: string;
  readonly node: string;
  readonly platform: string;
}

export function getInfo(env: { node: string; platform: string }): LabInfo {
  return { name: 'agent-control-lab', version: VERSION, ...env };
}

export function parseCommand(argv: readonly string[]): Result<'help' | 'version' | 'info' | 'providers' | 'auth-status' | 'quota'> {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return ok('help');
  }
  if (first === 'version' || first === '--version' || first === '-v') return ok('version');
  if (first === 'info') return ok('info');
  if (first === 'providers') return ok('providers');
  if (first === 'auth-status') return ok('auth-status');
  if (first === 'quota') return ok('quota');
  return err(`unknown command: ${first}`);
}

export * from './providers.ts';
export * from './auth.ts';
export * from './quota.ts';
export * from './claude-quota.ts';
