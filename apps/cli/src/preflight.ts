import {
  checkGitRepo,
  claudeCodeAdapter,
  claudeRegistry,
  claudeRunEnv,
  codexAdapter,
  createExec,
  defaultExec,
  detectAuth,
  detectProvider,
  discoverCodexModels,
  missingClaudeFlags,
  TOOLED_CLAUDE_FLAGS,
  parseClaudeHelp,
  planClaudeRun,
  planCodexRun,
  redirectingEnvNames,
  resolveSelection,
  scanClaudeSettingsFor,
  type AppServerSpawn,
  type AuthStatus,
  type ClaudeRunPlan,
  type CodexModelsResult,
  type Exec,
  type GitState,
  type ProviderStatus,
  type RunPlan,
  type Selection,
  type SelectionRequest,
  type SettingsScan,
  type PermissionProfile,
} from '@agent-control-lab/core';

/** The parts of the CLI dependencies the read-only preflights need. */
export interface PreflightDeps {
  readonly exec?: Exec;
  readonly appServer?: AppServerSpawn;
  readonly git?: (cwd: string) => Promise<GitState>;
  readonly claudeSettings?: (cwd: string) => Promise<SettingsScan>;
  /** Reuses an already-read Codex model catalog instead of asking the app-server again. */
  readonly codexModels?: () => Promise<CodexModelsResult>;
  /** Caller environment; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PreflightInput {
  readonly task: string;
  readonly request: SelectionRequest;
  readonly acceptUnverified: boolean;
  /** Validated working directory. */
  readonly cwd: string;
  /** Claude only; defaults to tool-less. */
  readonly profile?: PermissionProfile;
}

export interface ClaudePreflight {
  readonly plan: ClaudeRunPlan;
  readonly auth: AuthStatus;
  readonly provider: ProviderStatus;
  readonly selection: Selection;
  readonly settings: SettingsScan;
  readonly missingFlags: readonly string[] | undefined;
  readonly networkRedirects: readonly string[];
}

/** Local, read-only checks only (login status, --help, settings files, git): no model is called. */
export async function claudePreflight(input: PreflightInput, deps: PreflightDeps): Promise<ClaudePreflight> {
  const env = deps.env ?? process.env;
  // Probe with the same cleaned environment the run will use, so an API key in the caller's
  // environment cannot make the check pass or fail differently from the real run.
  const exec = deps.exec ?? createExec({ env: claudeRunEnv(env) });
  const [auth, provider, help, settings] = await Promise.all([
    detectAuth(claudeCodeAdapter, exec),
    detectProvider(claudeCodeAdapter, exec),
    exec('claude', ['--help'], { timeoutMs: 5000 }),
    (deps.claudeSettings ?? ((dir: string) => scanClaudeSettingsFor(dir)))(input.cwd),
  ]);
  const facts = help.kind === 'ok' ? parseClaudeHelp(help.stdout) : undefined;
  const selection = resolveSelection('claude', input.request, {
    claude: claudeRegistry,
    codex: { state: 'ok', models: [] },
    ...(facts?.efforts === undefined ? {} : { claudeEfforts: facts.efforts }),
  });
  const extraFlags = [
    ...(input.request.model === 'auto' ? [] : ['--model']),
    ...(input.request.effort === 'auto' && input.request.mode === 'normal' ? [] : ['--effort']),
  ];
  const tooled = (input.profile ?? 'text-only') !== 'text-only';
  const missingFlags = help.kind === 'ok' ? missingClaudeFlags(help.stdout, [...extraFlags, ...(tooled ? TOOLED_CLAUDE_FLAGS : [])]) : undefined;
  const networkRedirects = redirectingEnvNames(env);
  const plan = planClaudeRun({
    task: input.task,
    auth,
    selection,
    version: provider.version,
    missingFlags,
    settings,
    networkRedirects,
    acceptUnverified: input.acceptUnverified,
  });
  return { plan, auth, provider, selection, settings, missingFlags, networkRedirects };
}

export interface CodexPreflight {
  readonly plan: RunPlan;
  readonly auth: AuthStatus;
  readonly git: GitState;
  readonly selection: Selection;
}

/** Local, read-only checks only (git rev-parse, codex login status, model/list when pinned). */
export async function codexPreflight(input: PreflightInput, deps: PreflightDeps): Promise<CodexPreflight> {
  const git = await (deps.git ?? ((dir: string) => checkGitRepo(dir)))(input.cwd);
  const auth = await detectAuth(codexAdapter, deps.exec ?? defaultExec);
  const pinned = input.request.model !== 'auto' || input.request.effort !== 'auto';
  const codex: CodexModelsResult = pinned ? await (deps.codexModels?.() ?? discoverCodexModels(deps.appServer)) : { state: 'ok', models: [] };
  const selection = resolveSelection('codex', input.request, { claude: claudeRegistry, codex });
  const plan = planCodexRun({ task: input.task, auth, selection, git, acceptUnverified: input.acceptUnverified });
  return { plan, auth, git, selection };
}
