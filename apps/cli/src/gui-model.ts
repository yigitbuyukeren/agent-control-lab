/** Turns the CLI's own dry-run and status text into plain structures for the page. Nothing is invented here: a line that does not match stays raw. */

export interface DryRunEvidence {
  readonly kind: 'benchmark' | 'catalog' | 'documentation' | 'access' | 'other';
  readonly text: string;
}

export interface DryRunSetting {
  readonly value: string;
  readonly reason: string;
}

export interface DryRunStep {
  readonly index: number;
  readonly total: number;
  readonly id: string;
  readonly provider: string;
  readonly mode: string;
  readonly verdict: 'would-run' | 'would-refuse' | 'unknown';
  readonly refusal?: string;
  readonly model?: DryRunSetting;
  readonly effort?: DryRunSetting;
  readonly basis?: string;
  readonly uncertainty?: 'low' | 'medium' | 'high';
  readonly verification?: string;
  readonly evidence: readonly DryRunEvidence[];
  readonly notes: readonly string[];
}

export interface DryRunView {
  readonly meta: Readonly<Record<string, string>>;
  readonly steps: readonly DryRunStep[];
  readonly verdict: 'would-run' | 'would-refuse' | 'unknown';
}

const STEP_HEAD = /^ {2}step (\d+)\/(\d+) (\S+) \[(\S+)\]: (.*)$/;
const SETTING = /^ {6}(model|effort): (.+?); reason: (.*)$/;
const BASIS = /^ {6}routing basis: (.*?); uncertainty: (low|medium|high)\s*$/;
const TOP = /^ {2}([a-z][a-z -]*): (.*)$/;

export function evidenceKind(text: string): DryRunEvidence['kind'] {
  if (text.startsWith('benchmark evidence')) return 'benchmark';
  if (text.startsWith('evidence catalog')) return 'catalog';
  if (text.startsWith('claude access')) return 'access';
  if (/^(intent-based reading|suited by documentation|not named for|only one available|no documented)/.test(text) || text.includes('no documented purpose')) return 'documentation';
  return 'other';
}

function verdictOf(text: string): { verdict: DryRunStep['verdict']; refusal?: string; head: string } {
  const refuse = /(?:^|: )would refuse(?:: (.*))?$/.exec(text);
  if (refuse !== null) {
    const head = text.slice(0, refuse.index);
    return { verdict: 'would-refuse', head, ...(refuse[1] === undefined ? {} : { refusal: refuse[1] }) };
  }
  const run = /(?:^|: )would run$/.exec(text);
  if (run !== null) return { verdict: 'would-run', head: text.slice(0, run.index) };
  return { verdict: 'unknown', head: text };
}

type Mutable = {
  -readonly [K in keyof DryRunStep]: DryRunStep[K];
} & { evidence: DryRunEvidence[]; notes: string[] };

export function parseDryRun(output: string): DryRunView {
  const meta: Record<string, string> = {};
  const steps: Mutable[] = [];
  let current: Mutable | undefined;
  let verdict: DryRunView['verdict'] = 'unknown';
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const head = STEP_HEAD.exec(line);
    if (head !== null) {
      const parsed = verdictOf(head[5] ?? '');
      current = {
        index: Number(head[1]),
        total: Number(head[2]),
        id: head[3] ?? '',
        provider: head[4] ?? '',
        mode: parsed.head.replace(/,? ?subscription login$/, '').replace(/[:,\s]+$/, ''),
        verdict: parsed.verdict,
        evidence: [],
        notes: [],
        ...(parsed.refusal === undefined ? {} : { refusal: parsed.refusal }),
      };
      steps.push(current);
      continue;
    }
    if (line.startsWith('      ') && current !== undefined) {
      const setting = SETTING.exec(line);
      const basis = BASIS.exec(line);
      const body = line.trim();
      if (setting !== null) {
        const value: DryRunSetting = { value: setting[2] ?? '', reason: setting[3] ?? '' };
        if (setting[1] === 'model') current.model = value;
        else current.effort = value;
      } else if (basis !== null) {
        current.basis = basis[1] ?? '';
        current.uncertainty = basis[2] as 'low' | 'medium' | 'high';
      } else if (body.startsWith('verification: ')) {
        current.verification = body.slice('verification: '.length);
      } else if (body.startsWith('evidence: ')) {
        const text = body.slice('evidence: '.length);
        current.evidence.push({ kind: evidenceKind(text), text });
      } else {
        current.notes.push(body);
      }
      continue;
    }
    const top = TOP.exec(line);
    if (top !== null && top[1] !== undefined) {
      current = undefined;
      if (top[1] === 'verdict') verdict = top[2] === 'would run' ? 'would-run' : top[2]?.startsWith('would refuse') === true ? 'would-refuse' : 'unknown';
      else meta[top[1]] = top[2] ?? '';
    }
  }
  return { meta, steps, verdict };
}

export interface ProviderStatus {
  readonly id: 'claude' | 'codex';
  readonly name: string;
  readonly install?: string;
  readonly login?: string;
}

export interface QuotaWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resets?: string;
}

export interface QuotaView {
  readonly provider: 'claude' | 'codex';
  readonly plan?: string;
  readonly windows: readonly QuotaWindow[];
}

export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly string[];
  /** False when the efforts are only the vendor's documented levels, not a list from this account. */
  readonly effortsVerified: boolean;
  readonly defaultEffort?: string;
}

export interface ModelGroup {
  readonly provider: 'claude' | 'codex';
  readonly source: string;
  readonly models: readonly ModelInfo[];
}

const providerOf = (text: string): 'claude' | 'codex' | undefined => (/^claude/i.test(text) ? 'claude' : /^codex/i.test(text) ? 'codex' : undefined);

export function parseProviderLines(text: string): ProviderStatus[] {
  const out: ProviderStatus[] = [];
  for (const line of text.split('\n')) {
    const m = /^(Claude Code|Codex)\s{2,}(.*)$/.exec(line);
    const id = m?.[1] === undefined ? undefined : providerOf(m[1]);
    if (m !== null && id !== undefined) out.push({ id, name: m[1] ?? '', install: m[2] ?? '' });
  }
  return out;
}

export function mergeLogin(providers: readonly ProviderStatus[], authText: string): ProviderStatus[] {
  const auth = new Map(parseProviderLines(authText).map((p) => [p.id, p.install ?? '']));
  return providers.map((p) => ({ ...p, ...(auth.has(p.id) ? { login: auth.get(p.id) ?? '' } : {}) }));
}

export function parseQuota(text: string): QuotaView[] {
  const out: { provider: 'claude' | 'codex'; plan?: string; windows: QuotaWindow[] }[] = [];
  let current: (typeof out)[number] | undefined;
  for (const line of text.split('\n')) {
    const plan = /^(\S+(?: Code)?) plan: (.*)$/.exec(line);
    const provider = plan?.[1] === undefined ? undefined : providerOf(plan[1]);
    if (plan !== null && provider !== undefined) {
      current = { provider, plan: plan[2] ?? '', windows: [] };
      out.push(current);
      continue;
    }
    const win = /^ {2}(.+?): (\d+(?:\.\d+)?)% used(?:, resets (\S+))?/.exec(line);
    if (win !== null && current !== undefined) {
      current.windows.push({ label: win[1] ?? '', usedPercent: Number(win[2]), ...(win[3] === undefined ? {} : { resets: win[3] }) });
    }
  }
  return out;
}

export function parseModels(text: string): ModelGroup[] {
  const out: { provider: 'claude' | 'codex'; source: string; models: ModelInfo[] }[] = [];
  let current: (typeof out)[number] | undefined;
  for (const line of text.split('\n')) {
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('note:')) {
      const provider = providerOf(line);
      const source = /\((.*)\)\s*$/.exec(line)?.[1] ?? '';
      if (provider !== undefined) {
        current = { provider, source, models: [] };
        out.push(current);
      }
      continue;
    }
    const m = /^ {2}(\S+) \((.*?)\): efforts (.*)$/.exec(line);
    if (m === null || current === undefined) continue;
    const rest = m[3] ?? '';
    const documented = /^unknown \(documented levels: ([^)]*)\)/.exec(rest);
    const levels = documented?.[1] ?? /^([^;]*?)(?: default (\S+))?(?:;|$)/.exec(rest)?.[1] ?? '';
    const def = /default (\S+?)(?:;|$)/.exec(rest)?.[1];
    current.models.push({
      id: m[1] ?? '',
      label: m[2] ?? '',
      efforts: levels.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      effortsVerified: documented === null,
      ...(def === undefined ? {} : { defaultEffort: def }),
    });
  }
  return out;
}
