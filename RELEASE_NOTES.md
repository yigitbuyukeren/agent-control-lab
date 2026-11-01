# Agent Control Lab 1.0.0

A local control plane for the original Claude Code and Codex CLIs. No model of its own, no API keys, no commits or pushes.

**Install**: download `agent-control-lab-1.0.0.tgz` (and its `.sha256`) from this release, then
`npm install -g ./agent-control-lab-1.0.0.tgz && agent-control-lab doctor`. Node.js 24+ and Git required. Not published to npm.

**Highlights**: instruction discovery per agent; versioned handoff and crash-aware task history; confirmed linked-worktree creation;
sandboxed, probe-verified test execution; first-run `doctor`; a GUI that covers the whole flow; reproducible package.

**Verified**: CI on macOS, Linux and Windows (fake CLIs + real Git, packaged install smoke test). One live run was observed by the
maintainer on 31 Oct 2026 (Claude → Claude → Codex README write; diff checked, test command not run).

**Not verified / limits**: no OS sandbox on native Windows (use WSL2); Linux sandbox depends on bubblewrap and user namespaces; no
benchmarks; no live runs on Windows or Linux. See `docs/SUPPORT-MATRIX.md` and `docs/SECURITY.md`.
