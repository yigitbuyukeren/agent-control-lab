# Agent Control Lab

A local control plane for the **original Claude Code and Codex CLIs**. It does not contain a model of its own and never
calls a paid API: it starts the CLIs you already have, signed in with your own subscriptions, and puts guard rails around them.

```
pick a project → describe the task → prepare context → run the agent(s) → verify → review → keep a record
```

You can use only Claude, only Codex, or both together. Worktrees, multi-agent flows and model choice are never forced on you.

## What it does

| Area | What you get |
|---|---|
| Projects | Finds repositories, monorepo packages, nested repos and non-Git projects under a folder; suggests one from the task text but **never selects for you**. |
| Instructions | Shows which `CLAUDE.md` / `AGENTS.md` / rules each agent actually reads, with scope, hash and conflicts; can pass a bounded, secret-free excerpt on as untrusted data (`--with-instructions`). |
| Workflows | `plan-review` (read-only) and `plan-implement-review` (the implementation step writes, in an isolated linked worktree only). Each step's provider, model, effort and permission profile are yours to choose. |
| Worktrees | Creates a linked worktree on its own `acl/<id>` branch **outside** your repository, after a plan and a confirmation. Removal is separate, confirmed, never forced, and limited to worktrees the tool created. |
| Verification | An optional test command that runs inside an OS sandbox the tool has *proven* works on this machine (macOS `sandbox-exec`, Linux bubblewrap). No sandbox: it is refused unless you explicitly choose otherwise. |
| Handoff and history | A versioned, validated task record (Git HEAD, verified vs. agent-claimed evidence, open items) kept locally. No prompts, model output or plan text are stored. `resume-check` re-reads Git before anything continues. |
| Quota and routing | Existing Codex/Claude quota reading and model routing (`economy`, `balanced`, `quality`, measured and research evidence) are unchanged. Unknown stays `UNKNOWN`; nothing is invented. |
| GUI | A loopback-only browser UI for the whole flow: setup check, project discovery, instructions, worktree creation, preview, explicit confirmation, live progress, cancel, diff, tests and review. Every safety rule is enforced by the server, not only the page. |

## Install

Requires **Node.js 24+** and Git. Claude Code and/or Codex must be installed and signed in with a subscription.

```bash
# from a release package (agent-control-lab-<version>.tgz from GitHub Releases)
npm install -g ./agent-control-lab-<version>.tgz
agent-control-lab doctor
```

From source:

```bash
pnpm install
pnpm check            # typecheck, lint, tests
pnpm cli doctor
pnpm pack:release     # builds release/agent-control-lab-<version>.tgz (nothing is published)
pnpm smoke:pack       # installs that package into an empty folder and runs it
```

## Quick start

```bash
agent-control-lab doctor                                   # first-run check, calls no model
agent-control-lab gui                                      # the browser UI
agent-control-lab workspaces --root ~/code --task "fix the billing retry"
agent-control-lab instructions --cwd ~/code/billing
agent-control-lab worktree create --repo ~/code/billing    # shows the plan; add --confirm to create
agent-control-lab orchestrate --workflow plan-implement-review \
  --task "add a --json flag" --workspace <the printed worktree> --dry-run
```

Real runs start only with an explicit `--confirm` / `--confirm-write`, use your subscription quota, and never commit or push.
See [docs/USAGE.md](docs/USAGE.md). A Turkish quick start is in [docs/BASLANGIC.tr.md](docs/BASLANGIC.tr.md).

## Safety in one paragraph

Agents run through their own CLIs with the strictest profile that fits the step (no tools, read-only, or workspace-write without a
shell). Writing is only ever allowed in a linked worktree on a non-protected branch, which is snapshotted before and compared after
every run; anything unreadable fails closed. Model output, instruction files and handoff text are treated as untrusted data between
random-nonce markers. Nothing uses API keys, `--dangerously-skip-permissions`, silent provider fallback, commits or pushes.
Details and limits: [docs/SECURITY.md](docs/SECURITY.md).

## What has and has not been verified

- 700+ automated tests run on macOS, Linux and Windows in CI, using fake Claude/Codex CLIs and real Git; the packaged tarball is installed into an empty folder and run in CI on all three.
- Live-model evidence is **one** observed run (31 October 2026): a Claude → Claude → Codex chain wrote a README in an isolated worktree; the Git diff was checked and the test command was not run. There are no benchmarks and no live runs on Windows or Linux. See [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md).
- Windows has no OS sandbox support: the verification command is refused there unless you pick the explicit unsandboxed option. Use WSL2 for sandboxed checks.

## Documentation

[Usage](docs/USAGE.md) · [Architecture](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY.md) · [Instruction priorities](docs/INSTRUCTIONS.md) · [Handoff schema](docs/HANDOFF.md) · [Support matrix](docs/SUPPORT-MATRIX.md) · [Examples](docs/EXAMPLES.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Orchestration details](docs/ORCHESTRATE.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

MIT
