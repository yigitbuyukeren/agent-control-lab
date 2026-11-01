# Troubleshooting

Start with `agent-control-lab doctor`; it names the problem and the fix.

| Symptom | Cause and fix |
|---|---|
| `Claude Code … not signed in` | Run `claude` once and sign in with the Pro/Max account. API-key logins are refused on purpose. |
| `Codex … not signed in` | `codex login` with the ChatGPT account. |
| `refused: workspace must be a linked worktree` | Writing needs a linked worktree on its own branch. `agent-control-lab worktree create --repo <repo> --confirm`. |
| `refused: worktree is not clean` | Commit or discard your changes yourself; the tool never resets anything. |
| `the test command was not run: no working OS sandbox` | See the sandbox line in `--dry-run`. Linux: install bubblewrap; Windows: use WSL2; or choose `--verify-unsandboxed` knowingly. |
| Tests fail only in the sandbox | They need network, package installs or writes outside the worktree. Run them yourself after reading the diff. |
| `verification refused: build/test configuration changed` | The model edited `package.json`, a Makefile, etc. Review the diff and run tests by hand. |
| `quota … 95%` | A window is nearly used up. Wait for the reset or pick another provider. |
| `outcomes: not recorded, the store is locked` | A crashed run left a lock; see ORCHESTRATE.md → recovery. Runs are unaffected. |
| A task shows `interrupted` | The process that ran it is gone (crash, kill, power). Check the worktree with `git status`, then `tasks resume-check <id>`. |
| `tasks … unreadable (corrupt / newer-schema / too-large)` | The file is ignored; delete it with `tasks forget <id>` or `tasks clear`. |
| Port busy for the GUI | `agent-control-lab gui --port 0` picks a free one. |
| Windows path problems | Use absolute paths; quote paths with spaces. |
