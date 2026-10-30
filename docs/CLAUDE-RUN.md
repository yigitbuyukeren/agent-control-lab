# Claude run: what is checked and what is not

`run --provider claude` starts a tool-less, non-persistent `claude -p` on a Pro/Max
subscription login. Before it starts, a read-only preflight runs. Nothing here changes any
global or project setting, and `--dry-run` shows the result without starting anything.

## Child environment

The child gets an allowlist of variables (PATH, HOME, temp dirs, locale, `CLAUDE_CONFIG_DIR`, ...).
Credentials, base URLs, provider switches **and proxy/TLS variables** (`HTTP(S)_PROXY`,
`ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE/DIR`) are not forwarded, so the
subscription connection is never sent through a proxy or extra trust root inherited from the
parent shell.

If such variables (or `ANTHROPIC_BASE*`, `CLAUDE_CODE_USE_*`) are set in the calling shell, the
run is refused with `network-env-not-forwarded`, naming the variables but never their values,
because Claude would connect differently from the caller's own shell. `--accept-unverified` runs
anyway, without them. Settings files that set them are always refused.

## Settings scan

`--restricted` makes Claude ignore user, project and local settings; the scan is defense in
depth and the only check on managed settings. It reads (never writes, never logs values):

- user: `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`
- project and local (`.claude/settings.json`, `.claude/settings.local.json`) in the working
  directory, every directory up to the Git repository root, and, for a linked worktree, the
  main worktree root. Roots come from read-only `git rev-parse`.
- the managed settings **file** for the platform (macOS `/Library/Application Support/ClaudeCode/`,
  Linux `/etc/claude-code/`, Windows `%ProgramFiles%\ClaudeCode\`)

Claude Code 2.1.312 was observed (with `claude doctor`, no model call) to read local settings
from the repository root even from a subdirectory, but the exact resolution rules are not
documented, so the scan covers the union of places rather than guessing. Directories above the
repository root are not scanned.

It fails closed (`settings-unverifiable`): a file that exists but is unreadable, invalid,
over 256 KB or not a regular file, or a Git layout that cannot be established (git missing,
timed out, working directory not under the reported root), stops the run.

## What the scan does not cover

A clean scan is **not** proof that the active managed policy is safe. Not covered:

- MDM / configuration profiles (macOS) and registry/GPO policy (Windows)
- server-managed ("remote") settings and organisation policy, which `claude doctor` reports
  separately and which can be "not fetched" without credentials

The dry run prints this as `managed policy: file scan only ...`. Only a managed *file* is checked.

## Models and efforts: what can be verified

`agent-control-lab models claude` prints what can be established **without calling a model**, each with
its source, and `UNKNOWN` for everything else. Researched against Claude Code 2.1.312:

| Question | Answer | Source |
|---|---|---|
| CLI version, login method and plan | verified | `claude --version`, `claude auth status` |
| Effort names the installed CLI accepts | verified for the CLI (not per model) | the `--effort` text of `claude --help` |
| Model aliases | examples only (`fable`, `opus`, `sonnet`), not a list | the `--model` text of `claude --help` |
| Models this account can use | **UNKNOWN** | no CLI command lists them; only a real call proves access |
| Active default model | **UNKNOWN** | chosen by plan and account; `--restricted` ignores user and project settings |
| Efforts per model, ultracode support | **UNKNOWN** | not reported by the CLI |

Not used on purpose: `~/.claude.json` (`additionalModelOptionsCache`, `modelAccessCache`) and
`~/.claude/cache/model-catalog/*.json` look like cached account data, but they are undocumented
internals, can change between versions, and the catalog files are keyed by hashed account ids that cannot
be matched to the running login. They would be hints at best, not proof.

What changes in a run: an effort the installed CLI does not list is **blocked** before anything starts.
An accepted effort and any `--model` stay **unverified** (they need `--accept-unverified`), because no
local check proves this account can use that model or that the model supports that effort. The built-in
registry (`claude-opus-5-5`, ...) is shipped documentation and is never treated as access evidence.

Manual selection is covered by end-to-end tests against a fake `claude`: the chosen `--model` and
`--effort` reach the process unchanged, a refusal happens before any process starts, and a model the CLI
itself rejects ends as a failed step with no fallback to another model. Whether the real service accepts a
given model for an account can only be seen with a real call, which these tests never make. A future
runtime proof would be to read the model the response reports as used (not implemented: its output shape
was not observed here).
