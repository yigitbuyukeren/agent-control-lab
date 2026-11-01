# Instruction files and their priority

`agent-control-lab instructions --cwd <dir> [--provider claude|codex|both] [--context] [--json]` is read-only: it never creates or
changes an instruction file.

## What each agent reads

**Claude Code** (adapter `claude`): managed policy `CLAUDE.md`; `~/.claude/CLAUDE.md` and `~/.claude/rules/**`; then from the repository
root down to the working directory `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/**`. Later files are more specific and
win on conflict. Files in sub-directories load when Claude works there (`on-demand`).

**Codex** (adapter `codex`): `~/.codex/AGENTS.override.md` or `AGENTS.md`; then from the repository root down to the working directory one file per directory,
`AGENTS.override.md` if present, otherwise `AGENTS.md` (the override *shadows* it). Reading stops after 32 KiB of project instructions;
later files are `not-loaded`.

Providers added later get their own adapter; the resolver does not assume a shared format.

## Status values

| Status | Meaning |
|---|---|
| `loaded` | the provider reads it by itself in the way this tool runs it |
| `unknown` | Claude runs with `--safe-mode --restricted`, which ignores user and project settings; whether memory files still load there is not documented, so it is **not claimed** |
| `on-demand` | sub-directory file, read when the agent works in that directory |
| `shadowed` | replaced by an override in the same directory |
| `not-loaded` | beyond the provider's byte budget |
| `skipped` | unreadable, over 1 MiB, or a symlink that leaves the project |

Each entry also shows scope (`managed`, `user`, `project`, `subdirectory`, `local`), byte size, `sha256`, `@imports`, and warnings
for suspicious text (instruction override attempts, bypass requests, pipes into a shell, credential-like strings).

## Conflicts

`duplicate-content` (identical text in several files, so loading both wastes tokens), `override-shadows`,
`cross-provider-divergence` (CLAUDE.md and AGENTS.md differ in the same directory and CLAUDE.md does not import AGENTS.md),
`import-duplicates` (CLAUDE.md imports AGENTS.md).

## Passing instructions on

The safe mode is kept. With `--with-instructions` (or the GUI toggle) each model step gets a bounded excerpt:

- project-scope files only; never user-level, managed or `*.local` files;
- for Codex: the Claude files it cannot see; for Claude: everything project-level, because its loading is `unknown`;
- a file the provider already reads, or identical text already included, is not repeated;
- secret-looking lines and control characters removed; 3,000 characters per file, 8,000 in total;
- inside an untrusted block with the note that it never widens permissions or overrides the task.

Your instruction files are never modified.
