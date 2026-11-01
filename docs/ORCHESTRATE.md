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

# plan-implement-review

```
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --dry-run
orchestrate --workflow plan-implement-review --task "<text>" --workspace <linked worktree> --confirm-write [--accept-unverified] [--allow-partial-ignored-check] [--verify-command "pnpm test" --confirm-verify] [--timeout <seconds per step>]
```

By default Claude plans (tool-less) → Codex implements with the `workspace-write` sandbox → a local step
inspects the workspace → optional local verification → Claude reviews the diff (tool-less).
`plan-review` is unchanged and still read-only. Providers are choosable per step (`--step-provider plan=…`,
`implement=…`, `review=…`); the defaults above are only defaults.

**Evidence level.** The behaviour is covered by deterministic tests with fake CLIs and real Git. On 31 October 2026 a live
run was also observed by the project owner: a Claude → Claude → Codex step chain wrote a README in an isolated worktree. The Git diff
of that run was checked afterwards; the verification (test) command was **not** run in that session. That single observation is the only
live-model evidence; nothing here claims more (no benchmark, no repeated runs, no Windows or Linux live runs).

## Who may write, and where

- The only writer is the implementation step (Codex or Claude, whichever is chosen), and only in `--workspace`. Writing needs
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

**It executes code the model just wrote.** Since 1.0 it runs inside an operating-system sandbox when the
tool can *prove* one works on this machine, and is refused otherwise:

- macOS: `sandbox-exec` with a deny-by-default profile; Linux: bubblewrap (`bwrap`). Windows has no supported sandbox here
  (use WSL2 with bubblewrap).
- The sandbox allows writing only to the worktree and a private temp directory, no network, and denies reading a list of
  credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.claude`, `~/.codex`, ...). Reads of other files
  stay possible: it is a read deny-list, not a full filesystem jail.
- "Works" means a probe passed just before the run: a write inside the worktree succeeds; a write elsewhere, a read of a
  protected file and a TCP connection to a local listener all fail. `--dry-run` prints the result (`sandbox: ...`).
- No working sandbox: the command is **not run** and the step says why. `--verify-unsandboxed` (with `--confirm-verify`)
  is the explicit, separate choice to run it with your full user rights; it also skips the sandbox when one exists.
  The GUI offers it as an unchecked option in the confirmation dialog.

Package installs and anything that needs the network or writes caches outside the worktree will fail inside the sandbox;
that is intended. What is added besides the sandbox:

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

### Reliability of the records and of the comparison

- **Concurrent runs:** every change to `outcomes.jsonl` takes a lock directory (`outcomes.lock`, created with `mkdir`,
  atomic on Windows, macOS and Linux), re-reads the file inside the lock, and replaces it through a unique temp file
  and a rename, so parallel runs lose no record and a crash never leaves a half-written file. The holder writes a
  random token into the lock and removes the lock on release only if the token is still its own.
- **No automatic takeover:** a lock's age does not show that its owner died (a run can be slow or paused), and a
  process id can be reused, so a waiter never removes or replaces a lock it did not create. It waits up to 10 s and
  then **fails closed**: nothing is written, the run itself is unaffected, and it prints `outcomes: not recorded, the
  store is locked (<path>) ...`. `outcomes clear` reports the same and deletes nothing.
- **Manual recovery** (only after a run crashed or was killed, which is the one way a lock stays behind):
  1. Make sure no `agent-control-lab` run is active (Task Manager on Windows, `ps` elsewhere); a slow run releases
     the lock itself.
  2. Delete the lock directory named in the message: `outcomes.lock` inside the cache directory
     (`ACL_CACHE_DIR`, else `~/.cache/agent-control-lab` on Linux, `~/Library/Caches/agent-control-lab` on macOS,
     `%LOCALAPPDATA%\agent-control-lab` on Windows; the exact path is in the message). Its `owner` file holds the
     holder's process id if you want to check it.
  3. The records are intact: the data file is only ever replaced by a complete one. Leftover
     `outcomes.jsonl.*.tmp` files are harmless and can be deleted.
- **Comparable data only:** records are grouped by provider, step, task type and size. Without a test group the tasks
  behind two models' records are unknown, so a non-default model is chosen only if every compared group covers
  3+ days and the groups were measured in overlapping periods. Otherwise the default stays and the dry run says "not
  comparable".
- **Test groups:** `--eval-group <label>` (lowercase letters, digits, dashes, at most 40 characters; a label, never task
  text) tags the run's records and, with `--model-routing measured`, compares only records of that same label.
  Labelled and unlabelled records never mix. Passing the label is your statement that the group's runs use the same
  task set; the tool cannot check that, and says so. No benchmark is run: you run the tasks yourself, with
  `--step-model` / `--step-effort`, and the manual runs are what gets recorded.
- **Errors and timeouts:** each group line shows pass, fail, error, timeout, the share of runs that ended in error or
  timeout, unmeasured runs, median seconds and days covered. A model whose better pass rate hides many failed runs is
  not chosen: its error/timeout share must be at most 20% and at most 10 points above every rival's.

## Research routing: `--model-routing research`

Recommends a model from **published benchmark results** kept in a versioned catalog
(`packages/core/src/evidence-catalog.ts`, version `2026-10-30.2`). Each entry records the source URL, the dates the source
states (evaluation, publication, model release), the date this catalog read the page, benchmark and version, the model
id and variant as the source labels it, the effort and harness the result was measured with, and a confidence level.
It makes no model call and runs no benchmark.

- **Sources and confidence:** `independent` (Artificial Analysis, one method for all models): high. `official-vendor`
  (a vendor's own launch page: Anthropic, OpenAI): medium. `community` (a forum user's report): low, shown as a
  supporting note and never used to decide anything.
- **Only what a source states:** OpenAI's two launch pages could be read in the in-app browser (the page served its
  tr-TR locale). Only figures written in the page text are recorded; chart values are images and were not read, and
  anything that could not be read is not added. Differences a page states without each model's own score (for example
  "GPT-6.1 Sol is 6.4 points ahead of GPT-6 Sol") are kept as stated differences, not as scores.
- **What is compared:** only results with the same benchmark, benchmark version, unit, **harness** and **effort**; a
  vendor's own environment is not the same harness as another evaluator's, and competitor figures on a vendor page come from
  public reports. An effort or harness a source does not name (`unspecified`, or "highest" without a level) is never
  compared.
- **Effort must be the same as the run's:** a `max` result is not taken as superiority for a `medium` or `high` run. A
  model is recommended only if the evidence was measured at exactly the effort the step will run at (from `--policy`,
  task size, risk keywords and a reliable quota reading); when it is pinned, that effort is applied, and the model must
  list it as supported now.
- **Task fit:** a benchmark counts only for the work it measures: `agentic-coding` for `implement`, `code-review` for
  `review`, `planning` for `plan`. The Artificial Analysis Intelligence Index is a **general** index: it is shown as context
  and is not evidence about coding, code review or planning. Computer-use, business-workflow and science-agent results are
  context too.
- **Dates:** freshness is counted from the evaluation date, else the publication date, else the model release date as the
  source states it (at most 120 days old). The day this catalog read a page is never used: **reading a page again does
  not refresh a benchmark**. A result with none of these dates is not used for a decision, and the dry run says
  "evaluation date not stated by the source" where that is the case (today: all Artificial Analysis and OpenAI entries).
- **Sufficient evidence:** at least two models this step can use now, a lead of at least 3 index points or 5 percentage
  points, and either an independently produced comparison or two agreeing ones. Conflicts, ties and a single vendor table
  keep the provider default.
- **Access:** a Codex model is chosen only if the provider lists it now. A Claude model is never pinned: the dry run shows
  what the evidence favours as advice and `claude access: UNKNOWN`.
- **Prices:** deliberately not recorded or used. An API price per token says nothing about your subscription quota.
- **Manual wins:** `--step-model` / `--step-effort` are never overridden. Ultracode is never selected. The other routing
  modes are unchanged.
- **Dry run:** prints the decision, each comparison with scores, benchmark, effort, harness, confidence, source URL and
  dates, the results that were ignored and why, context-only results, and low-confidence notes.
- **Today's outcome:** with the shipped data no step gets a recommendation. The only absolute OpenAI figure for a coding
  benchmark (GPT-6.1 Terra, Terminal-Bench 4.0, 50.3% at an unnamed "highest" effort) has no comparable GPT-6.1 Sol figure;
  OpenAI's DeepSWE difference compares unnamed efforts; its AutomationBench and OSWorld differences are not coding. The
  provider default is kept, and the evidence shown explains why. To update, add entries from a page you opened, with its
  URL and date, state only what it states, and bump the catalog version.

## Guided routing: `--model-routing guided`

`research` stays exactly as it is (strict benchmark evidence only). `guided` adds a second, clearly labelled basis for when
that evidence is not enough, and shows both.

1. **Measured benchmark evidence first,** with the same strict rules as `research` (same benchmark, version, harness and effort;
   task-fit; dated; independent or doubly confirmed). If it recommends a listed Codex model, that model is used, the basis is
   `measured benchmark evidence` and the uncertainty is `low`. The dry run also shows what the documented intent would have chosen
   and whether it agrees.
2. **Otherwise an intent-based choice from vendor documentation** (basis `documented intent of the model (vendor documentation),
   not a measurement`, uncertainty `medium`), from `packages/core/src/model-guide.ts` (version `2026-10-31.1`). It records what
   OpenAI (API guide, Codex models page, GPT-6.1 Terra launch page) and Anthropic (models overview) say each model is for, and
   the few relations they state between models. Nothing else is assumed: no price, no benchmark, no ranking of its own.
3. **Otherwise the provider default** (uncertainty `high`), with the reason.

How the intent-based choice is made (all heuristics are labelled as such in the dry run):

- **Kind of work:** `implement` is coding, `plan` and `review` are professional work; a task the size/risk heuristics call easy is
  `focused`, anything else `complex`. Under `--policy quality` an easy task is not treated as focused (no downsizing).
- **Suited models:** only models the provider lists now **and** that the documentation names for that kind of work, minus
  those the vendor says are less suited (for example OpenAI says GPT-6.1 Terra is not the better choice for the most complex
  coding, so Terra is never picked for it). A listed model with no documented purpose is ignored.
- **Policy decides among several suited models,** using only stated relations: `quality` takes the one documented as the most
  capable (Astra over Sol), `economy` the one documented as the more efficient (Sol over Astra, Luna over the rest),
  `balanced` the one the vendor itself labels as a balance of speed, cost and intelligence (Sol). If the documentation does
  not settle it, the default is kept.
- **Then** the chosen model's effort comes from `--policy` as usual.
- **Claude:** never pinned, access is UNKNOWN; at most advice appears in the dry run. **Manual** `--step-model` / `--step-effort`
  always win, and ultracode is never selected.
- The documentation pages state no date; the guide records when they were read (2026-10-31). Vendor descriptions are
  marketing-adjacent intent, not proof of performance on your task; that is why this basis carries medium uncertainty at best.

## Local GUI (v0.3: preview, and a real `plan-review` run)

`pnpm cli gui [--port <n>]` (default 4173) serves a Turkish dark dashboard at `http://127.0.0.1:<port>/` (side navigation on wide screens, bottom bar on narrow ones). Views: orchestration (task editor, workflow, a visual Plan → Implement → Review flow with per-step model/effort selects, the five `--model-routing` modes, `--policy`, workspace and verify fields shown only for `plan-implement-review`), providers (install, login, real quota windows, model tables) and safety.

Results are cards per step built from the real `orchestrate --dry-run` output: selected model and effort with their verified/default state, verification, basis, uncertainty, and an expandable evidence panel that keeps strict benchmark evidence apart from documentation-based reading. The raw CLI text is kept in a collapsed details section. Quota comes only from the local `quota` command; where none is available (Claude today) the page says so and shows nothing made up.

Safety is unchanged from v0.1: loopback only; per-start random token plus Host/Origin checks on every API call; the server builds the argument vector itself, always with `--dry-run --no-record` and never a confirm flag (`--accept-unverified` is only added when you tick its option, and for a real run it needs its own second confirmation (the server refuses the run otherwise)); `/api/status` runs only the read-only `providers`, `auth-status`, `quota` and `models` commands; no external resources, strict CSP, no browser storage, nothing stored or logged.

### Real `plan-review` run (v0.3)

Only `plan-review` can run for real; `plan-implement-review` stays preview-only. A run is the same `orchestrate --workflow plan-review --confirm` the CLI runs (no second executor), started in-process with an abort signal, and the page polls its progress.

Gates, all enforced by the server and not only by the page: a project directory is chosen (a directory-only picker lists folder names, nothing else); a dry-run preview with exactly the same settings has just succeeded with `would run` (valid 10 minutes, one use); the request carries an explicit `confirm` set from a dialog that needs a checkbox (and a second one when `--accept-unverified` was ticked); only one run exists at a time (previews and status wait or are refused meanwhile); a run does not start when a read quota window is at 95% or more (unknown quota is shown as unknown, not guessed). The per-step timeout (2 to 15 minutes) goes to the CLI, and a whole-run watchdog (twice that plus a minute) aborts a stuck run.

Cancel/stop aborts the run's signal, which makes the existing orchestration stop its child processes; the page shows `cancelling` until it has actually settled. Closing the GUI server with Ctrl+C does the same and waits. Preflight refusals (proxy/TLS variables, login, policy) are shown verbatim as a refusal with no step started; nothing is skipped automatically. There is no retry, provider fallback, API-key use, commit or push, and runs use `--no-record`.

The log and output shown are masked first (API keys, tokens, Bearer headers, passwords, URL credentials, private keys, the GUI's own token). This is best-effort pattern masking, not a guarantee. Model output is shown as text only and labelled untrusted. Only the last run's masked log is kept, in server memory. There is no token streaming: the CLI returns each step's answer when the step ends, so live progress is the step status lines and the answers appear as steps finish.

`--accept-unverified` in the GUI is your explicit choice and it is passed to the real run too, not only to the preview: the option text says so, the confirmation dialog shows it as accepted and needs a separate checkbox, and the server rejects a real run that lacks `confirmAcceptUnverified`. Nothing sets it automatically, and a refused preflight is never retried with it.

The live log keeps the newest 400 masked lines. The cursor is an absolute line count, so polling continues after the limit; a client that fell behind gets the newest lines plus how many were skipped. The page keeps at most 400 lines as well.

## Step provider choice

`--step-provider <plan|review>=auto|claude|codex` chooses which provider runs the planning or review step (`auto` keeps the workflow default: plan on Claude, review on Codex in `plan-review`, on Claude in `plan-implement-review`). The implementation step always stays on Codex; `--step-provider implement=claude` is refused because there is no safe Claude write runner. A Claude step is tool-less, a Codex step runs in a read-only sandbox. A manual provider choice overrides automatic routing for that step, and `--step-model` / `--step-effort` are verified against the chosen provider, so a model of the other provider is refused. Dry-run, preflight, quota guard and confirmations are unchanged; the GUI's quota guard only considers the providers a run uses.

## GUI: real plan-implement-review

The GUI runs `plan-implement-review` through the same CLI path (`--confirm-write`, plus `--confirm-verify` only for a test command). Required: a successful dry-run preview of exactly the same settings; the worktree unchanged since that preview (head, branches, dirty and ignored files are fingerprinted with read-only Git calls); its own explicit write confirmation; a separate confirmation for the test command; and the usual CLI preflight/inspect checks and quota guard (the Codex implementation always counts toward Codex quota). One run at a time; cancel stops the processes, `inspect` still runs and nothing is rolled back. After the run the page shows the workspace state read from Git (branch, HEAD before/after, changed and new files, whether anything was committed), not model text.

## Providers and permission profiles per step

Every step (plan, implement, review) can run on Claude or Codex (`--step-provider step=claude|codex`),
with its own model, effort (`--step-model`, `--step-effort`) and permission profile
(`--step-profile step=auto|text-only|read-only|workspace-write`). Both providers can read the project,
edit files and use the terminal, within these profiles. There is no unrestricted profile.

| Profile | Allowed in | Claude | Codex |
|---|---|---|---|
| `text-only` | plan, review | no tools (legacy mode) | not available |
| `read-only` (default) | plan, review | Read/Grep/Glob (no shell) | read-only sandbox |
| `workspace-write` (default) | implement only | adds Edit/Write; still no shell (the confirmed `--verify-command` runs solely as the local verify step after inspection) | workspace-write sandbox |

Claude runs with `--restricted --safe-mode --permission-mode dontAsk` and no shell tool: the official docs say built-in
read-only Bash commands (cat, grep, git diff, ...) run without approval in every mode and bypass path rules, so Bash is absent and denied. Everything not allowed is denied, file tools stay inside the working directory,
and protected files (`.env*`, `.git`, `.github/workflows`, `.claude`, `.codex`, `.husky`, `.npmrc`, `CLAUDE.md`, `AGENTS.md`, ...) are denied for Edit/Write (and secrets/git internals for Read) through `Edit(path)`/`Read(path)` deny rules (`Write(path)` never matches, so none are used) before anything runs; the Git inspection afterwards remains a second layer. `bypassPermissions` / `--dangerously-skip-permissions` are never built. Writing needs the existing
`--workspace` (a verified linked worktree) and `--confirm-write`; the Git inspection, change limits,
verify gate, quota and preflight checks apply unchanged to either provider. The tooled Claude flags are
checked against the installed `claude --help` and the run is refused when any is missing.
The tooled Claude behaviour is verified against flag definitions and fake agents; the only live observation is the one described under plan-implement-review.
