import { maskSecrets } from './gui-secrets.ts';
import type { Io } from './main.ts';

export type RunStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'refused' | 'cancelled' | 'timeout';
export type StepState = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'skipped';

export interface RunStep {
  readonly id: string;
  readonly provider: string;
  readonly status: StepState;
  readonly seconds?: number;
  readonly error?: string;
}

export interface RunSection {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly text: string;
  readonly usedModel?: string;
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly steps: readonly RunStep[];
  readonly lines: readonly string[];
  /** Absolute index of the next line to ask for (`from`); it keeps growing even when old lines are dropped. */
  readonly next: number;
  /** Lines between the requested cursor and the oldest line still kept: dropped for memory, so the stream is never stuck. */
  readonly skipped?: number;
  readonly sections?: readonly RunSection[];
  readonly summary?: string;
  readonly refusal?: readonly string[];
}

export type GuiRun = (argv: readonly string[], io: Io, signal?: AbortSignal) => Promise<number>;

const MAX_LINES = 400;
const MAX_LINE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 200_000;
const PROGRESS = /^step (\d+)\/(\d+) (\S+) \[(\S+)\] (running|completed|failed|timeout|cancelled|skipped)(?: \(([\d.]+)s\))?(?:: (.*))?$/;
const SECTION = /^== step \d+\/\d+ (\S+) \[(\S+)\] (\S+?)(?: \([\d.]+s\))? ==$/;

export function parseRunOutput(output: string): { sections: RunSection[]; summary?: string } {
  const sections: RunSection[] = [];
  let current: { id: string; provider: string; status: string; lines: string[] } | undefined;
  let summary: string | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const used = current.lines.find((l) => l.startsWith('model used (reported by the response): '));
    const text = current.lines.filter((l) => l !== used).join('\n').trim();
    sections.push({ id: current.id, provider: current.provider, status: current.status, text, ...(used === undefined ? {} : { usedModel: used.slice('model used (reported by the response): '.length) }) });
    current = undefined;
  };
  for (const line of output.split('\n')) {
    const head = SECTION.exec(line);
    if (head !== null) {
      flush();
      current = { id: head[1] ?? '', provider: head[2] ?? '', status: head[3] ?? '', lines: [] };
    } else if (line.startsWith('summary: ')) {
      flush();
      summary = line.slice('summary: '.length);
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  flush();
  return { sections, ...(summary === undefined ? {} : { summary }) };
}

export interface RunManagerOptions {
  readonly run: GuiRun;
  readonly now: () => number;
  /** Extra strings (the GUI token) that must never appear in what the page shows. */
  readonly hide: readonly string[];
}

/** Holds at most one real run. Everything shown is masked; nothing is written to disk. */
export class RunManager {
  private readonly options: RunManagerOptions;
  private controller: AbortController | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private timedOut = false;
  private settled: Promise<void> = Promise.resolve();
  private id = 0;
  private status: RunStatus | undefined;
  private startedAt = 0;
  private endedAt: number | undefined;
  private exitCode: number | undefined;
  private steps: RunStep[] = [];
  private lines: string[] = [];
  /** Total lines ever added; `lines` holds only the newest MAX_LINES of them. */
  private seq = 0;
  private partial = '';
  private out = '';
  private errText = '';
  private sections: RunSection[] | undefined;
  private summary: string | undefined;
  private refusal: string[] | undefined;

  constructor(options: RunManagerOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.status === 'running' || this.status === 'cancelling';
  }

  start(argv: readonly string[], steps: readonly { id: string; provider: string }[], watchdogMs: number): void {
    if (this.active) throw new Error('a run is already active');
    this.id += 1;
    this.status = 'running';
    this.startedAt = this.options.now();
    this.endedAt = undefined;
    this.exitCode = undefined;
    this.steps = steps.map((s) => ({ ...s, status: 'pending' as const }));
    this.lines = [];
    this.seq = 0;
    this.partial = '';
    this.out = '';
    this.errText = '';
    this.sections = undefined;
    this.summary = undefined;
    this.refusal = undefined;
    this.timedOut = false;
    const controller = new AbortController();
    this.controller = controller;
    this.watchdog = setTimeout(() => {
      this.timedOut = true;
      this.cancel();
    }, watchdogMs);
    this.settled = this.options
      .run(argv, { out: (t) => { this.out = (this.out + t).slice(0, MAX_OUTPUT_CHARS); }, error: (t) => { this.onError(t); } }, controller.signal)
      .then((code) => { this.finish(code); }, () => { this.finish(1, true); });
  }

  cancel(): boolean {
    if (this.status !== 'running') return false;
    this.status = 'cancelling';
    this.controller?.abort();
    return true;
  }

  /** Aborts an active run and waits until the orchestration has stopped its processes. */
  async shutdown(): Promise<void> {
    this.cancel();
    await this.settled;
  }

  snapshot(from = 0): RunSnapshot | undefined {
    if (this.status === undefined) return undefined;
    const first = this.seq - this.lines.length;
    const asked = Number.isInteger(from) && from >= 0 ? Math.min(from, this.seq) : 0;
    const start = Math.max(asked, first);
    const skipped = start - asked;
    return {
      id: String(this.id),
      status: this.status,
      startedAt: this.startedAt,
      steps: this.steps,
      lines: this.lines.slice(start - first),
      next: this.seq,
      ...(skipped > 0 ? { skipped } : {}),
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.sections === undefined ? {} : { sections: this.sections }),
      ...(this.summary === undefined ? {} : { summary: this.summary }),
      ...(this.refusal === undefined ? {} : { refusal: this.refusal }),
    };
  }

  private mask(text: string): string {
    return maskSecrets(text, this.options.hide);
  }

  private onError(chunk: string): void {
    this.errText = (this.errText + chunk).slice(0, MAX_OUTPUT_CHARS);
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    for (const raw of parts) this.addLine(raw);
  }

  private push(line: string): void {
    this.lines.push(line);
    this.seq += 1;
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  private addLine(raw: string): void {
    const line = this.mask(raw).slice(0, MAX_LINE_CHARS);
    if (line.trim() === '') return;
    this.push(line);
    const m = PROGRESS.exec(line);
    if (m === null) return;
    const [, , , id, provider, state, secs, err] = m;
    this.steps = this.steps.map((s) =>
      s.id === id
        ? { id: s.id, provider: provider ?? s.provider, status: state as StepState, ...(secs === undefined ? {} : { seconds: Number(secs) }), ...(err === undefined ? {} : { error: err }) }
        : s,
    );
  }

  private finish(code: number, crashed = false): void {
    if (this.partial !== '') this.addLine(this.partial);
    this.partial = '';
    clearTimeout(this.watchdog);
    this.exitCode = code;
    this.endedAt = this.options.now();
    const refused = /orchestrate refused/.test(this.errText);
    this.status = crashed ? 'failed' : this.timedOut ? 'timeout' : code === 0 ? 'completed' : code === 130 ? 'cancelled' : refused ? 'refused' : 'failed';
    if (this.status === 'refused') this.refusal = this.mask(this.errText).split('\n').filter((l) => l.trim() !== '').slice(0, 30);
    if (crashed) this.push('internal error: the run stopped unexpectedly');
    const parsed = parseRunOutput(this.mask(this.out));
    this.sections = parsed.sections;
    if (parsed.summary !== undefined) this.summary = parsed.summary;
    this.steps = this.steps.map((s) => (s.status === 'pending' && this.status !== 'completed' ? { ...s, status: this.status === 'refused' ? 'skipped' : s.status } : s));
    this.controller = undefined;
  }
}
