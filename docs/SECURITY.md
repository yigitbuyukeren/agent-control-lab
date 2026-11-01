# Security model

## What the tool trusts

Only **you**, through the command line or the GUI. Everything else is data: model output, plan text, diffs, test output,
`CLAUDE.md`/`AGENTS.md`, handoff packets, file names. Data crosses between steps inside `<<<BEGIN UNTRUSTED … nonce>>>` markers with a
fresh random nonce; look-alike delimiters in the data are defused. Instruction files never raise permissions, remove a confirmation or
change a sandbox.

## What it never does

API keys or hidden endpoints; `--dangerously-skip-permissions` or any bypass; commits, pushes, branch switches in your checkout;
silent provider fallback or retries; deleting or resetting a worktree on its own; storing prompts or model output; sending
anything over the network itself.

## Layers

1. **Permission profiles** per step: `text-only`, `read-only`, `workspace-write`. Claude runs `--restricted --safe-mode` with allow-lists and no shell tool; Codex runs in its own read-only or workspace-write sandbox.
2. **Workspace rules**: writes only in a verified linked worktree, not the main one, on a branch that is not detached or protected (`main`, `master`, `develop`, `release*`, …), clean at start.
3. **Snapshot and compare** before/after: HEAD and branches, dirty/ignored/untracked files, main-worktree writes, protected paths (`.git`, CI workflows, credentials, tool config). Anything unreadable or partial fails closed.
4. **Review input integrity**: if the diff cannot be shown complete, no approval is possible.
5. **OS sandbox for the test command** (below).
6. **Server-side GUI checks**: token, Host/Origin, preview-must-match, separate confirmations for write, test command and unverified settings, one run at a time.

## The test command

Running tests means running code a model just wrote. The tool treats that as a separate boundary:

- It runs only inside a sandbox the tool has just *proved* works (probe: write inside the worktree OK; write elsewhere, read of a protected file and a local TCP connection all blocked).
- macOS `sandbox-exec` and Linux bubblewrap are supported. Windows is not: use WSL2.
- Writes are limited to the worktree and a private temp directory; no network; a deny-list of credential locations is unreadable. **Other files remain readable.** This is not a VM.
- No proven sandbox → the command is not run. `--verify-unsandboxed` is the explicit, separate opt-out and says so everywhere.
- Before running, the step is refused if build/test configuration changed; afterwards the workspace is compared again.
- `sandbox-exec` is deprecated by Apple but still shipped; if it disappears the probe fails and the command is refused.

## Instruction text

Discovered, hashed and listed read-only. When passed on (`--with-instructions`) it is limited to project-scope files, deduplicated,
capped, stripped of secret-looking lines and control characters, and placed in an untrusted block. User-level and `*.local` files are
never exported.

## Task history

Local JSON files, mode 0600, atomic writes, bounded size and count, schema-validated on read. Corrupt, oversized or newer-schema files
are reported and ignored. No prompt, secret, raw model output, plan text or file content is stored.

## Known limits

- Prompt injection cannot be eliminated; sandboxes and Git checks are the backstop, not the model's good behaviour.
- Fingerprints for huge ignored directories compare one level deep (reported as PARTIAL, needs an explicit flag); a same-size rewrite inside the filesystem's mtime resolution is invisible.
- The sandbox read deny-list covers known credential locations only.
- Claude model access cannot be verified; it stays `UNKNOWN`.

Report vulnerabilities privately through GitHub security advisories on the repository.
