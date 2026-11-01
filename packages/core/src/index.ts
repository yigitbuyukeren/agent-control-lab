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

export function parseCommand(argv: readonly string[]): Result<'help' | 'version' | 'info' | 'providers' | 'auth-status' | 'quota' | 'statusline-collect' | 'route' | 'models' | 'outcomes' | 'run' | 'orchestrate' | 'workspaces' | 'instructions' | 'tasks'> {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return ok('help');
  }
  if (first === 'version' || first === '--version' || first === '-v') return ok('version');
  if (first === 'info') return ok('info');
  if (first === 'providers') return ok('providers');
  if (first === 'auth-status') return ok('auth-status');
  if (first === 'quota') return ok('quota');
  if (first === 'statusline-collect') return ok('statusline-collect');
  if (first === 'route') return ok('route');
  if (first === 'models') return ok('models');
  if (first === 'outcomes') return ok('outcomes');
  if (first === 'run') return ok('run');
  if (first === 'orchestrate') return ok('orchestrate');
  if (first === 'workspaces') return ok('workspaces');
  if (first === 'instructions') return ok('instructions');
  if (first === 'tasks') return ok('tasks');
  return err(`unknown command: ${first}`);
}

export * from './providers.ts';
export * from './auth.ts';
export * from './quota.ts';
export * from './claude-quota.ts';
export * from './claude-cache.ts';
export * from './quota-model.ts';
export * from './routing.ts';
export * from './models.ts';
export * from './app-server-client.ts';
export * from './claude-help.ts';
export * from './selection.ts';
export * from './step-selection.ts';
export * from './step-policy.ts';
export * from './step-router.ts';
export * from './outcome-record.ts';
export * from './outcome-stats.ts';
export * from './evidence-catalog.ts';
export * from './evidence-router.ts';
export * from './model-guide.ts';
export * from './process-runner.ts';
export * from './codex-run.ts';
export * from './git-preflight.ts';
export * from './claude-run.ts';
export * from './claude-settings.ts';
export * from './repo-roots.ts';
export * from './permission-profile.ts';
export * from './agent-run.ts';
export * from './orchestration.ts';
export * from './workflows.ts';
export * from './git-state.ts';
export * from './workspace-policy.ts';
export * from './workspace-guard.ts';
export * from './workspace-discovery.ts';
export * from './verify.ts';
export * from './claude-integration.ts';
export * from './instructions.ts';
export * from './handoff.ts';
export * from './task-store.ts';
