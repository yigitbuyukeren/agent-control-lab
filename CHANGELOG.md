# Changelog

## 1.0.1 — 2026-11-01

### Fixed
- GUI real runs were never added to task history: the preview's `--no-record` was carried into the real run. A preview still never records; the real run now records (task/handoff and result) only when the new GUI option "Görev geçmişine kaydet" is on, and keeps `--no-record` when it is off (the default). The confirmation dialog shows the choice.
- Tests cover completed, failed and cancelled GUI runs (and crash visibility), `tasks`, `tasks resume-check` and the GUI history list.

Server confirmations, preview matching and the privacy policy (no prompt, model output or plan text stored) are unchanged.

## 1.0.0 — 2026-11-01

First stable release: the experimental CLI/GUI became a product other developers can install and use daily.

### Added
- **Project instructions resolver**: per-provider adapters for `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules`, `AGENTS.md`, `AGENTS.override.md`; scope, hash, load status, conflicts, suspicious-text flags; `instructions` command. Optional bounded, secret-free context for model steps (`--with-instructions`, GUI toggle).
- **Handoff packet and task history**: versioned schema with strict validation; verified vs. agent-claimed evidence; atomic, private, bounded local store; crash-visible running record; `tasks` and `tasks resume-check` (re-reads Git).
- **Managed worktrees**: `worktree create | list | remove` on `acl/<id>` branches outside the repository; plan first, confirmed, never forced, tool-created only.
- **OS sandbox for the test command**: macOS `sandbox-exec` and Linux bubblewrap, proven by a probe before every use; refused when unavailable unless `--verify-unsandboxed` is chosen explicitly.
- **`doctor`** first-run diagnosis and a GUI "Hazırlık" view (setup check, task history); GUI project instructions panel and worktree creation.
- **Reproducible release package**: esbuild single-file bundle, `npm pack` tarball with SHA-256, packaged-install smoke test, CI on macOS, Linux and Windows.
- Documentation: English README, Turkish quick start, usage, architecture, security model, instruction priorities, handoff schema, support matrix, troubleshooting, examples, contributing.

### Changed
- GUI no longer states that only Codex writes; it shows the provider actually chosen for each step.
- The verification command no longer runs "outside any sandbox" by default; see above.
- Stale claim "never run against real models" replaced by the exact evidence: one observed live run on 31 Oct 2026 (Claude → Claude → Codex README write, Git diff verified, test command not run).

### Unchanged
Quota reading, model routing (auto, adaptive, measured, research, guided), outcome records, safe-mode Claude profiles, Codex sandboxes, preflights, confirmations.

### Known limits
No OS sandbox on native Windows; the sandbox restricts reads only for a deny-list of credential locations; live-model evidence is a single observed run; Claude model access stays `UNKNOWN`.

## 0.1.0
Experimental CLI skeleton, quota and routing, local GUI, plan-review and plan-implement-review workflows.
