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

## Model and effort per step

Both workflows accept `--step-model <step>=auto|<model-id>` and `--step-effort <step>=auto|<level>`,
repeatable, for `plan`, `implement` (plan-implement-review only) and `review`. The step decides the
provider (plan-review: plan = Claude, review = Codex; plan-implement-review: plan = Claude, implement =
Codex, review = Claude), and the existing model discovery, effort compatibility and preflight checks run
for each step.

- `auto` (or no flag) keeps the provider default; which model or level that is, is not known here.
- An unknown step, a step the workflow lacks, a repeated step, a malformed value or `ultracode` is refused
  while parsing. Ultracode is never selected by this option.
- A definite incompatibility (unknown Codex model, unsupported effort) is **blocking** and nothing starts.
  Anything that cannot be verified (every pinned Claude model, an effort without a pinned model) needs
  `--accept-unverified`.
- `--dry-run` prints model, effort, verification status (verified / UNVERIFIED / BLOCKED / nothing pinned)
  and the reason for each step, and calls no model.

## Cost policy: `--policy economy|balanced|quality`

Both workflows accept `--policy` (default `balanced`). It chooses an **effort** for steps whose effort you
did not set; `--step-model` and `--step-effort` always win, including an explicit `auto`.

It acts only on **verified** data and otherwise keeps the provider default, saying why in the dry run:

- **Model:** never chosen. There is no verified cost or capability ranking, so the model is yours or the
  provider's.
- **Effort:** set only when you pinned the model and the provider reported its supported efforts (Codex
  `model/list`). With no pinned model, or for Claude (per-model efforts are not documented), nothing can be
  verified, so the policy does nothing. Today this means `balanced` changes nothing unless you pin a Codex
  model.
- **Base level:** economy `low`, balanced `medium`, quality `high`, then the nearest supported level at or
  below the target (the lowest supported one if all are above it). The plan step gets +1 under `quality`
  (it steers every later step). Task size is a text-length heuristic only (+1 large, -1 small except
  economy), not a difficulty assessment.
- **Quota:** used only when the reading is live or fresh and complete; `low`, `critical` or `exhausted`
  lowers the level by one. Stale, partial, failed or missing quota counts as unknown and is not used
  (never treated as healthy). It is read only when a step has a verifiable model.
- **Never:** ultracode, a model switch, a provider switch, or an unverified setting (so no extra
  `--accept-unverified` is ever caused by the policy).

The dry run prints the policy line and, per step, the effort with the policy's reason.

# plan-implement-review (infrastructure, first stage)

```
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --dry-run
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --confirm-write [--accept-unverified] [--allow-partial-ignored-check] [--verify-command "pnpm test" --confirm-verify] [--timeout <seconds per step>]
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
HEAD, branch, every local branch ref, `status`, ignored files, tracked file modes, and the main
worktree's dirty paths. After the implementation step (also after a failure, timeout or cancel) the
`inspect` step compares and **fails** on:

- a moved HEAD (a commit), a branch switch, any other branch created, moved or deleted
  (the main branch above all), no changes at all;
- **ignored files**: `git status` never lists them, so every ignored file is fingerprinted (kind,
  size, mtime) before and after; any added, removed or changed one fails. Ignored directories are
  walked (symlinks not followed) up to 20000 entries. A larger one (typically `node_modules`) is
  only compared one level deep; that is **partial coverage**, so the workspace is refused unless you
  pass `--allow-partial-ignored-check`, and the report says PARTIAL. Fingerprints are not content
  hashes: a same-size rewrite inside the mtime resolution is not seen;
- **tracked symlinks and file types** (`git diff --raw` modes): a symlink added, changed or removed,
  a file turned into a directory/symlink, an executable-bit change, a submodule change;
- **writes into the main worktree**: its dirty paths are fingerprinted too;
- size: more than 25 files or 400 changed lines, a new file over 20 KB (40 KB together), binary files,
  new symlinks, paths outside the workspace, and protected paths (`.git`, `.github/workflows`,
  `.claude`, `.codex`, `.husky`, `.env*`, `.npmrc`, `.gitmodules`, `.gitattributes`, `CLAUDE.md`,
  `AGENTS.md`). The limits are sized so that a change inside them fits the review input.

Hooks and `.git` internals outside the worktree are not diffed; the sandbox is what protects them.

## What the reviewer sees, and when there is no review

The review input is the diff of tracked files followed by every new text file as added lines, at most
12000 characters in total, and the report states `review input: complete`. If any part cannot be shown
in full (diff unreadable or cut, a new file unreadable, not UTF-8 text, or cut, report too long) the
change is **rejected as `review-incomplete`**: the report says `INCOMPLETE`, the review step is skipped
and no approval can come out of it. The reviewer is also told not to approve unless the input says it
is complete. The verdict is advisory model output, never a gate; you decide what to merge.

## Verification

`--verify-command` is opt-in and needs its **own approval**, `--confirm-verify` (separate from
`--confirm-write`; without it the command is refused at parse time and nothing starts). The command is
plain words starting with `pnpm npm yarn bun deno node pytest python python3 cargo go make dotnet mvn
gradle swift`; shell syntax is rejected, not interpreted. It runs without a shell in the workspace with
a cleaned environment (no API keys or proxy variables), a timeout, and process-tree kill.

**It still executes code the model just wrote, outside any model sandbox. There is no portable sandbox
for it; this is risk reduction, not isolation.** What is added:

- before running, verification is **refused** if the step changed a file that decides what a test or
  build runs (`package.json`, `Makefile`, `pyproject.toml`, `conftest.py`, `Cargo.toml`, `build.rs`,
  `*.config.*`, `*.csproj`, ...), so the model cannot rewire the test command; run those tests yourself
  after reading the diff;
- afterwards the workspace and the main worktree are compared again: a moved HEAD or branch, a
  changed main-worktree path, rewritten tracked files, a new protected path, **any added, removed or
  rewritten untracked or ignored file** (build output, caches, `coverage/`) fail the step, because the
  review only saw the state before verification. A test run that writes such files therefore fails
  verification; clean them up yourself or run the tests by hand. Fingerprints are kind/size/mtime, not
  content hashes;
- a failed verification stops the review. Reading the diff and running tests yourself remains the
  safest option, and verification can simply be left out.

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

## Model routing: `--model-routing auto|adaptive`

`auto` (default) changes nothing. `adaptive` (both workflows) may pin a **Codex** model for a step you left on
`auto`, and only from evidence:

- **Evidence used:** the step's role and provider, the provider's own model list (`model/list` and the efforts it
  reports), the target effort of `--policy` (adjusted by task-length size, a risky-keyword check such as
  security/auth/migration/concurrency, and a fresh or live quota reading), and your manual flags.
- **Rule:** a model is pinned only if it is the **single** listed model that supports the target effort, every other
  listed model reports its efforts, and the list has at least two models. If every model qualifies, several do, none
  does, the list is missing or a model reports no efforts, the provider default is kept and the reason is printed.
  No quality or cost ranking is assumed, so nothing is chosen "because it is better".
- **Claude:** never pinned automatically. No command proves which models the account can use, so this stays UNKNOWN.
- **Manual wins:** a step with `--step-model` or `--step-effort` is left alone. Ultracode is never selected.
- `--dry-run` prints, per step, the decision and `evidence:` lines (role, task heuristics, model list, target effort,
  models supporting it). A pinned model comes from the account's own list, so it is not an unverified choice.

## Measured routing: `--model-routing measured`, `outcomes`, `--no-record`

Real `orchestrate` runs write one small local record per step that ran; `--no-record` turns it off and
`outcomes clear` deletes everything (`outcomes` shows counts). Records live in `outcomes.jsonl` in the per-user cache
directory (`ACL_CACHE_DIR` overrides it), owner-only where the platform allows it, newest 2000 kept.

- **Kept:** UTC day, step, provider, model id or `default`, effort or `default`, task type (keyword heuristic),
  size class, outcome and whole seconds. **Never kept:** task text, model output, paths, session ids, exact times.
- **Evidence:** `pass` is a passing `--verify-command` on a change that also passed the workspace inspection;
  `fail` is a failed verification or a change the inspection rejected. A model's own claim (a review verdict,
  "done") is never evidence. A completed step with no local check is `unmeasured`; provider failures are
  `error`/`timeout`. Neither enters the success rate. Only the Codex `implement` step with a verification command
  can produce `pass`, so Claude steps are never measurable and never routed by measurement.
- **Decision:** among records of the same provider, step, task type and size from the last 90 days, a group
  (model + effort, or the provider default) counts at 8+ measured outcomes. With two or more such groups, a model
  is chosen only if its 95% Wilson interval lies entirely above every other group's. Too little data, one group,
  overlapping intervals or the default being best keep the provider default. Duration is shown, not used.
- **Still checked now:** the chosen model must be in the provider's current Codex list and support the recorded
  effort, otherwise the default is kept. Manual `--step-model` / `--step-effort` always win; ultracode is never
  selected. Nothing is run to collect data: no benchmark, no extra model call.
- `--dry-run` prints the data amount per group, the intervals, the uncertainty and the reason.
