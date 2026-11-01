import { createHash } from 'node:crypto';
import { untrustedBlock } from './orchestration.ts';

export const HANDOFF_SCHEMA_VERSION = 1;

export const TASK_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const STAGE_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'skipped'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** `agent` is what a model said about itself; `verified` was observed by this tool through Git or a test command. */
export type HandoffEvidenceSource = 'agent' | 'verified';

export interface HandoffStage {
  readonly id: string;
  readonly provider: 'claude' | 'codex';
  readonly status: StageStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface HandoffEvidence {
  readonly kind: 'git-change' | 'test' | 'review';
  readonly source: HandoffEvidenceSource;
  readonly summary: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly at: string;
}

export interface HandoffPacket {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: TaskStatus;
  /** Short label chosen by the user. The task prompt itself is never stored. */
  readonly label: string;
  readonly project: { readonly root: string; readonly name: string };
  readonly scope: { readonly repoRoot?: string; readonly worktree?: string; readonly createdByTool: boolean };
  readonly git: { readonly head: string; readonly branch?: string; readonly clean: boolean };
  readonly instructions: readonly { readonly path: string; readonly sha256: string; readonly provider: 'claude' | 'codex' }[];
  /** Only a hash and length by default; `text` exists when the user opted in to keeping it. */
  readonly plan?: { readonly sha256: string; readonly chars: number; readonly text?: string };
  readonly acceptance: readonly string[];
  readonly changes: readonly { readonly path: string; readonly status: string; readonly source: HandoffEvidenceSource }[];
  readonly evidence: readonly HandoffEvidence[];
  readonly openItems: readonly string[];
  readonly nextStage?: string;
  readonly stages: readonly HandoffStage[];
  /** Process that owns a running task, used to tell a crash from a live run. */
  readonly owner?: { readonly pid: number };
}

export const HANDOFF_LIMITS = {
  label: 120,
  text: 2000,
  items: 100,
  evidence: 200,
  changes: 500,
  instructions: 100,
  stages: 20,
  planText: 16_000,
  path: 1024,
} as const;

const ID = /^t-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const isTaskId = (value: string): boolean => ID.test(value);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Hand-written strict validator: unknown keys, wrong types, control characters and oversize values are all rejected. */
export function validateHandoff(input: unknown): { readonly ok: true; readonly packet: HandoffPacket } | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const bad = (path: string, why: string): null => {
    if (errors.length < 20) errors.push(`${path}: ${why}`);
    return null;
  };
  const keys = (o: Obj, path: string, allowed: readonly string[]): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(path, `unknown key ${k.slice(0, 30)}`);
  };
  const str = (v: unknown, path: string, max: number, re?: RegExp): null => {
    if (typeof v !== 'string') return bad(path, 'must be a string');
    if (v.length > max) return bad(path, `longer than ${String(max)}`);
    if (CONTROL.test(v)) return bad(path, 'contains control characters');
    if (re !== undefined && !re.test(v)) return bad(path, 'wrong format');
    return null;
  };
  const opt = (o: Obj, k: string, f: (v: unknown) => void): void => {
    if (k in o && o[k] !== undefined) f(o[k]);
  };
  const list = (v: unknown, path: string, max: number, each: (item: unknown, p: string) => unknown): null => {
    if (!Array.isArray(v)) return bad(path, 'must be an array');
    if (v.length > max) return bad(path, `more than ${String(max)} items`);
    v.forEach((item, i) => {
      each(item, `${path}[${String(i)}]`);
    });
    return null;
  };
  const oneOf = (v: unknown, path: string, values: readonly string[]): null => {
    if (typeof v !== 'string' || !values.includes(v)) return bad(path, 'not an allowed value');
    return null;
  };
  if (!isObj(input)) return { ok: false, errors: ['packet: must be an object'] };
  keys(input, 'packet', ['schemaVersion', 'taskId', 'createdAt', 'updatedAt', 'status', 'label', 'project', 'scope', 'git', 'instructions', 'plan', 'acceptance', 'changes', 'evidence', 'openItems', 'nextStage', 'stages', 'owner']);
  if (input['schemaVersion'] !== HANDOFF_SCHEMA_VERSION) bad('schemaVersion', `only version ${String(HANDOFF_SCHEMA_VERSION)} is supported`);
  str(input['taskId'], 'taskId', 20, ID);
  str(input['createdAt'], 'createdAt', 40, ISO);
  str(input['updatedAt'], 'updatedAt', 40, ISO);
  oneOf(input['status'], 'status', TASK_STATUSES);
  str(input['label'], 'label', HANDOFF_LIMITS.label);
  const project = input['project'];
  if (!isObj(project)) bad('project', 'must be an object');
  else {
    keys(project, 'project', ['root', 'name']);
    str(project['root'], 'project.root', HANDOFF_LIMITS.path);
    str(project['name'], 'project.name', 200);
  }
  const scope = input['scope'];
  if (!isObj(scope)) bad('scope', 'must be an object');
  else {
    keys(scope, 'scope', ['repoRoot', 'worktree', 'createdByTool']);
    opt(scope, 'repoRoot', (v) => {
      str(v, 'scope.repoRoot', HANDOFF_LIMITS.path);
    });
    opt(scope, 'worktree', (v) => {
      str(v, 'scope.worktree', HANDOFF_LIMITS.path);
    });
    if (typeof scope['createdByTool'] !== 'boolean') bad('scope.createdByTool', 'must be a boolean');
  }
  const git = input['git'];
  if (!isObj(git)) bad('git', 'must be an object');
  else {
    keys(git, 'git', ['head', 'branch', 'clean']);
    str(git['head'], 'git.head', 64, HEAD);
    opt(git, 'branch', (v) => {
      str(v, 'git.branch', 255);
    });
    if (typeof git['clean'] !== 'boolean') bad('git.clean', 'must be a boolean');
  }
  list(input['instructions'], 'instructions', HANDOFF_LIMITS.instructions, (item, p) => {
    if (!isObj(item)) return bad(p, 'must be an object');
    keys(item, p, ['path', 'sha256', 'provider']);
    str(item['path'], `${p}.path`, HANDOFF_LIMITS.path);
    str(item['sha256'], `${p}.sha256`, 64, HEX64);
    oneOf(item['provider'], `${p}.provider`, ['claude', 'codex']);
  });
  opt(input, 'plan', (plan) => {
    if (!isObj(plan)) return bad('plan', 'must be an object');
    keys(plan, 'plan', ['sha256', 'chars', 'text']);
    str(plan['sha256'], 'plan.sha256', 64, HEX64);
    if (!Number.isInteger(plan['chars']) || (plan['chars'] as number) < 0) bad('plan.chars', 'must be a non-negative integer');
    opt(plan, 'text', (v) => {
      str(v, 'plan.text', HANDOFF_LIMITS.planText);
    });
  });
  list(input['acceptance'], 'acceptance', HANDOFF_LIMITS.items, (v, p) => {
    str(v, p, HANDOFF_LIMITS.text);
  });
  list(input['changes'], 'changes', HANDOFF_LIMITS.changes, (item, p) => {
    if (!isObj(item)) return bad(p, 'must be an object');
    keys(item, p, ['path', 'status', 'source']);
    str(item['path'], `${p}.path`, HANDOFF_LIMITS.path);
    str(item['status'], `${p}.status`, 40);
    oneOf(item['source'], `${p}.source`, ['agent', 'verified']);
  });
  list(input['evidence'], 'evidence', HANDOFF_LIMITS.evidence, (item, p) => {
    if (!isObj(item)) return bad(p, 'must be an object');
    keys(item, p, ['kind', 'source', 'summary', 'command', 'exitCode', 'at']);
    oneOf(item['kind'], `${p}.kind`, ['git-change', 'test', 'review']);
    oneOf(item['source'], `${p}.source`, ['agent', 'verified']);
    str(item['summary'], `${p}.summary`, HANDOFF_LIMITS.text);
    opt(item, 'command', (v) => {
      str(v, `${p}.command`, 300);
    });
    opt(item, 'exitCode', (v) => {
      if (!Number.isInteger(v)) bad(`${p}.exitCode`, 'must be an integer');
    });
    str(item['at'], `${p}.at`, 40, ISO);
    // Only this tool may call something verified; an agent's review or claim can never carry that label.
    if (item['kind'] === 'review' && item['source'] === 'verified') bad(p, 'a review is an agent statement, never verified');
  });
  list(input['openItems'], 'openItems', HANDOFF_LIMITS.items, (v, p) => {
    str(v, p, HANDOFF_LIMITS.text);
  });
  opt(input, 'nextStage', (v) => {
    str(v, 'nextStage', 80);
  });
  list(input['stages'], 'stages', HANDOFF_LIMITS.stages, (item, p) => {
    if (!isObj(item)) return bad(p, 'must be an object');
    keys(item, p, ['id', 'provider', 'status', 'startedAt', 'endedAt']);
    str(item['id'], `${p}.id`, 40);
    oneOf(item['provider'], `${p}.provider`, ['claude', 'codex']);
    oneOf(item['status'], `${p}.status`, STAGE_STATUSES);
    opt(item, 'startedAt', (v) => {
      str(v, `${p}.startedAt`, 40, ISO);
    });
    opt(item, 'endedAt', (v) => {
      str(v, `${p}.endedAt`, 40, ISO);
    });
  });
  opt(input, 'owner', (owner) => {
    if (!isObj(owner)) return bad('owner', 'must be an object');
    keys(owner, 'owner', ['pid']);
    if (!Number.isInteger(owner['pid']) || (owner['pid'] as number) <= 0) bad('owner.pid', 'must be a positive integer');
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, packet: input as unknown as HandoffPacket };
}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Verified facts first, agent statements separately and labelled. Everything is untrusted data for the next agent. */
export function renderHandoffForAgent(packet: HandoffPacket, nonce: string): string {
  const verified = packet.evidence.filter((e) => e.source === 'verified');
  const claimed = packet.evidence.filter((e) => e.source === 'agent');
  const lines = [
    `task ${packet.taskId} (${packet.status}); next stage: ${packet.nextStage ?? 'none'}`,
    `git head at hand-off: ${packet.git.head}${packet.git.branch === undefined ? ' (detached)' : ` on ${packet.git.branch}`}`,
    'VERIFIED BY THE TOOL (Git/test results):',
    ...packet.changes.filter((c) => c.source === 'verified').map((c) => `  ${c.status} ${c.path}`),
    ...verified.map((e) => `  ${e.kind}: ${e.summary}${e.exitCode === undefined ? '' : ` (exit ${String(e.exitCode)})`}`),
    'CLAIMED BY AN AGENT (not verified):',
    ...claimed.map((e) => `  ${e.kind}: ${e.summary}`),
    ...packet.changes.filter((c) => c.source === 'agent').map((c) => `  ${c.status} ${c.path}`),
    'ACCEPTANCE CRITERIA:',
    ...packet.acceptance.map((a) => `  - ${a}`),
    'OPEN ITEMS:',
    ...packet.openItems.map((a) => `  - ${a}`),
  ];
  return untrustedBlock('HANDOFF', lines.join('\n').slice(0, 24_000), nonce);
}

export interface CurrentGit {
  readonly head: string;
  readonly branch: string | undefined;
  readonly clean: boolean;
}

export type ResumeProblem = 'head-changed' | 'branch-changed' | 'worktree-dirty' | 'stale' | 'already-finished' | 'running-elsewhere';

/** Resuming never trusts the stored state: HEAD, branch and cleanliness are compared with what Git says now. */
export function checkResume(packet: HandoffPacket, current: CurrentGit | undefined, now: Date, options: { maxAgeDays?: number; ownerAlive?: boolean } = {}): ResumeProblem[] {
  const problems: ResumeProblem[] = [];
  if (packet.status === 'completed') problems.push('already-finished');
  if (packet.status === 'running' && options.ownerAlive === true) problems.push('running-elsewhere');
  const ageMs = now.getTime() - Date.parse(packet.updatedAt);
  if (!(ageMs <= (options.maxAgeDays ?? 7) * 86_400_000)) problems.push('stale');
  if (current === undefined) return [...problems, 'head-changed'];
  if (current.head !== packet.git.head) problems.push('head-changed');
  if (current.branch !== packet.git.branch) problems.push('branch-changed');
  if (!current.clean && packet.git.clean) problems.push('worktree-dirty');
  return problems;
}
