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
