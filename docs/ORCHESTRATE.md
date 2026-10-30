# orchestrate

```
agent-control-lab orchestrate --workflow plan-review --task "<text>" --cwd <repo> --dry-run
agent-control-lab orchestrate --workflow plan-review --task "<text>" --cwd <repo> --confirm [--accept-unverified] [--timeout <seconds per step>]
```

`plan-review`: Claude drafts a plan, then Codex reviews it independently and read-only, and
both results are printed. `--dry-run` runs only local checks (login status, `--help`, settings
files, `git rev-parse`) and calls no model. `--confirm` is the user's approval to start real
sessions that use the subscription quota.

## Safety

- Both steps use the existing runners and preflights: Claude is tool-less (`--restricted`,
  `--safe-mode`, no session persistence) on a Pro/Max login; Codex runs in a read-only sandbox
  inside a Git repository on a ChatGPT login. Nothing starts unless **both** preflights pass.
- No API keys, no provider fallback, no retries, no file changes by either step.
  The first step that does not complete stops the workflow; later steps are `skipped` and
  earlier results are still shown (a partial result, exit code 1).
- `--timeout` applies to each step. Ctrl+C / SIGTERM cancels: the running child is stopped and
  later steps are not started (exit 130).
- Each step reports status (`completed`, `failed`, `timeout`, `cancelled`, `skipped`), provider,
  duration and a fixed error message. Raw stderr and provider error text are never shown.

## Data between steps

Step output is untrusted model text. Claude's plan is cut to 16000 characters, control
characters are removed, and it is given to Codex between `<<<BEGIN/END UNTRUSTED PLAN
<nonce>>>>` markers with an instruction to judge it, not follow it. The nonce is random per run
and delimiter look-alikes inside the plan are defused. This reduces prompt-injection risk; it
cannot eliminate it, and Codex's read-only sandbox is the actual backstop. Claude has no tools,
so it plans from the task text alone and cannot read the repository.

The managed-policy limit in `docs/CLAUDE-RUN.md` applies here too.

# plan-implement-review (infrastructure, first stage)

```
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --dry-run
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --confirm-write [--accept-unverified] [--verify-command "pnpm test"] [--timeout <seconds per step>]
```

Claude plans (tool-less) → Codex implements with the `workspace-write` sandbox → a local step
inspects the workspace → optional local verification → Claude reviews the diff (tool-less).
`plan-review` is unchanged and still read-only. This stage is infrastructure covered by mock
and fake-CLI tests; it has not been run against real models.

## Who may write, and where

- The only writer is the Codex implementation step, and only in `--workspace`. Writing needs
  `--confirm-write`; `--confirm` alone is refused, and `--dry-run` never writes.
- The workspace must already exist. It is never created, switched, reset or cleaned. It must be
  the **root of a linked Git worktree** (not the main working tree) on a **branch of its own**:
  not detached, not `main`/`master`/`trunk`/`develop`/`dev`/`prod`/`production`/`release*`/`hotfix*`, and
  not the branch the main worktree has checked out. It must be **clean** so every change is
  attributable. Anything unreadable fails closed. Create one yourself:
  `git worktree add -b my-branch ../my-worktree`.
- Both preflights (Claude and Codex subscription logins, settings scan, Git) and the workspace
  check must pass before any step starts. No API keys, retries or provider fallback.

## Git state before and after

Read-only `git` only (`--no-optional-locks`, `core.fsmonitor=false`, no external diff or textconv):
HEAD, branch, every local branch ref, and `status`. After the implementation step (also after a
failure, timeout or cancel) the `inspect` step compares and **fails** on: a moved HEAD (a commit), a
branch switch, any other branch created, moved or deleted (the main branch above all), no changes at
all, more than 40 files or 1500 changed lines, a new file over 100 KB (300 KB together), binary files,
new symlinks, paths outside the workspace, and protected paths (`.git`, `.github/workflows`,
`.claude`, `.codex`, `.husky`, `.env*`, `.npmrc`, `.gitmodules`, `.gitattributes`, `CLAUDE.md`,
`AGENTS.md`). The report lists files and line counts, then a diff of tracked files cut to 10000
characters (new files appear by name and size only). Hooks and `.git` internals outside the worktree
are not diffed; the sandbox is what protects them.

## Verification

`--verify-command` is opt-in. It must be plain words starting with `pnpm npm yarn bun deno node
pytest python python3 cargo go make dotnet mvn gradle swift`; shell syntax is rejected, not
interpreted. It runs without a shell in the workspace with a cleaned environment (no API keys or
proxy variables). **It executes the code the model just wrote, outside any model sandbox**; read the
diff first if that matters. A failure stops the review.

## Failure, timeout, cancel

Steps stop at the first failure and later ones are `skipped`; the inspection always runs if the
implementation started. Timeouts and Ctrl+C stop the child process tree. **Nothing is reverted,
deleted, committed or pushed**: the workspace keeps whatever was written, the final state is printed,
and you decide with `git -C <workspace> status` / `diff`, then commit yourself if you accept it.
Exit codes: 0 completed, 1 failed or partial, 130 cancelled, 2 usage.

## Untrusted data

The plan, the change report and the verification output are model- or code-produced text. They are
passed between steps as `<<<BEGIN/END UNTRUSTED …>>>` blocks with a per-run nonce, bounded to 16000
characters. The Claude reviewer has no tools, so it cannot be tricked into acting; the Codex writer is
told to follow only what fits the task and the rules, and the inspection catches rule-breaking after the
fact. That reduces risk; it does not remove it.
