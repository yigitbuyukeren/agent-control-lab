# Support matrix

"Tested in CI" means the automated suite (fake CLIs, real Git) and the package smoke test run on that system on every push.
"Live" means a person ran it against real models and watched.

| | macOS | Linux | Windows (native) | WSL2 |
|---|---|---|---|---|
| Node 24, CLI, GUI server | tested in CI | tested in CI | tested in CI | same as Linux (not separately tested) |
| Project discovery, instructions, handoff, tasks | tested in CI | tested in CI | tested in CI (path separators included) | as Linux |
| Worktree create / remove | tested in CI | tested in CI | tested in CI | as Linux |
| OS sandbox for the test command | `sandbox-exec`, probed at run time; probe test in CI | bubblewrap if installed *and* the probe passes (some distributions restrict user namespaces) | **not available**: test command refused unless `--verify-unsandboxed` | bubblewrap inside WSL2 |
| Packaged tarball installs and runs | tested in CI | tested in CI | tested in CI | – |
| Live Claude + Codex run | **one observed run** (31 Oct 2026, Claude → Claude → Codex README write; diff checked, test command not run) | none | none | none |

Provider support: Claude Code (Pro/Max subscription login) and Codex CLI (ChatGPT login). API-key logins are not used.
Claude model access and per-model efforts cannot be verified from the CLI and are reported as `UNKNOWN`; the tool never invents them.

## Known platform limits

- Windows: no OS sandbox. Claude/Codex themselves run natively as their vendors support; for isolated tests use WSL2.
- Linux without `bwrap` or with restricted user namespaces: `doctor` says so; the test command is refused.
- macOS: `sandbox-exec` is deprecated by Apple; it keeps working today and is probed every time.
- Network file systems, case-insensitive path collisions and exotic Git setups (sparse checkout, submodules inside the worktree) are not specially handled; unreadable state fails closed.
