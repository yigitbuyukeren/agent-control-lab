# Usage

All commands are read-only unless they say otherwise. Real model runs need an explicit `--confirm` / `--confirm-write`.

## Setup and diagnosis

```bash
agent-control-lab doctor [--json]     # Node, Git, Claude/Codex install + sign-in, OS sandbox probe, data folder
agent-control-lab providers           # local --version checks
agent-control-lab auth-status         # login method only
agent-control-lab quota all           # Claude (local cache) + Codex limits
```

## Choosing the project

```bash
agent-control-lab workspaces --root ~/code [--task "…"] [--select <path-or-name>] [--json]
agent-control-lab instructions --cwd <dir> [--provider claude|codex|both] [--context] [--json]
```

A task only produces a *suggestion*. When two projects fit, nothing is suggested as final and you choose.

## Worktrees

```bash
agent-control-lab worktree create --repo <repo>            # plan only
agent-control-lab worktree create --repo <repo> --confirm  # creates acl/<id> outside the repo
agent-control-lab worktree list
agent-control-lab worktree remove <id> --confirm           # only tool-created, only if clean, never forced
```

Manual worktrees (`git worktree add …`) work exactly as before: pass them with `--workspace`.

## Running

```bash
# read-only plan + review
agent-control-lab orchestrate --workflow plan-review --task "…" --cwd <repo> --dry-run
agent-control-lab orchestrate --workflow plan-review --task "…" --cwd <repo> --confirm

# plan → implement → inspect → (verify) → review, in a linked worktree
agent-control-lab orchestrate --workflow plan-implement-review --task "…" --workspace <worktree> --dry-run
agent-control-lab orchestrate --workflow plan-implement-review --task "…" --workspace <worktree> --confirm-write \
  [--verify-command "pnpm test" --confirm-verify] [--with-instructions] [--timeout 600]
```

Single-agent setups: `--step-provider plan=codex --step-provider implement=codex --step-provider review=codex` (or all `claude`).
Per step: `--step-model`, `--step-effort`, `--step-profile`. Policies: `--policy economy|balanced|quality`;
routing: `--model-routing auto|adaptive|measured|research|guided`. A manual choice always wins. See [ORCHESTRATE.md](ORCHESTRATE.md).

## History

```bash
agent-control-lab tasks                    # list (add --json from `tasks list --json`)
agent-control-lab tasks show <id>
agent-control-lab tasks resume-check <id>  # asks Git again; non-zero means do not continue blindly
agent-control-lab tasks clear
```

## GUI

`agent-control-lab gui [--port N]` opens a loopback-only page. Views: **Orkestrasyon** (project, task, flow, preview, confirmation,
live run, diff and review), **Sağlayıcılar** (login, quota, models), **Hazırlık** (setup check and task history), **Güvenlik**.
The confirmation dialog has separate switches for writing files, for the test command, and an optional unchecked switch to run it without a sandbox.
