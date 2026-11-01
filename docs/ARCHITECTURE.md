# Architecture

Concepts are kept apart on purpose; mixing them is how a tool ends up writing in the wrong place.

| Concept | Meaning | Where |
|---|---|---|
| Workspace | A folder you point the tool at; it may contain many projects | `workspace-discovery.ts` |
| Project | One thing you work on: a repo, a monorepo package or a non-Git folder | candidates from discovery |
| Git repository | A `.git` boundary (nested repos are their own boundary) | `repo-roots.ts`, `git-state.ts` |
| Worktree | A linked checkout; the **only** place an implementation step may write | `workspace-policy.ts`, `worktree-manager.ts` |
| Task | One recorded run and its evidence | `handoff.ts`, `task-store.ts` |

## Layout

```
apps/cli        command line, local GUI server and page, workflow wiring
packages/core   all logic: providers, quota, routing, guards, instructions, handoff, sandbox, worktrees
packages/shared version and the Result type
scripts         build (esbuild bundle), pack (npm pack), smoke-pack
```

Core has no runtime dependencies. The distributable package is one bundled ES module plus docs.

## Flow of a `plan-implement-review` run

1. Parse and validate arguments (nothing starts without explicit confirmation flags).
2. Preflight each step: CLI installed, subscription login, flags it needs, settings, quota (a window at 95% stops the run).
3. Snapshot the worktree (HEAD, branches, dirty and ignored file fingerprints, main worktree state). Unreadable → refuse.
4. Optionally add the bounded project-instruction excerpt (`--with-instructions`).
5. Run steps strictly in order, no retries, no provider fallback: plan → implement → *local inspect* → optional *local verify* → review.
6. After the write step the inspector compares the snapshot with the world; limits and protected paths are enforced; the review sees the diff.
7. Record outcomes (counts only) and a task packet (facts only). Nothing is committed, pushed, reverted or deleted.

## Modules added for 1.0

- **instructions.ts** adapters per provider (see [INSTRUCTIONS.md](INSTRUCTIONS.md)).
- **handoff.ts / task-store.ts** schema, validator, atomic bounded store (see [HANDOFF.md](HANDOFF.md)).
- **worktree-manager.ts** plan, create, list, remove for tool-created worktrees.
- **sandbox.ts** detection, wrapping and a real probe; `verify.ts` runs inside it when it passes.
- **doctor.ts** first-run diagnosis; the GUI "Hazırlık" view uses it.

## Local data

`ACL_CACHE_DIR`, or `~/Library/Caches/agent-control-lab` (macOS), `$XDG_CACHE_HOME`/`~/.cache/agent-control-lab` (Linux),
`%LOCALAPPDATA%\agent-control-lab` (Windows). It holds outcome counts, task packets, the registry of worktrees the tool created,
and the Claude quota cache. No prompts, model output or file contents.

## GUI

Loopback only, per-start random token, Host and Origin checks on every API call, strict CSP, no external resources and no browser
storage. The server builds every argument vector itself; the page cannot pass raw flags.
