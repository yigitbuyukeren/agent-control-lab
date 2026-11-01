# Contributing

```bash
pnpm install
pnpm check          # typecheck + lint + tests (all must pass)
pnpm pack:release && pnpm smoke:pack
```

- Node 24+, pnpm. TypeScript runs unbundled from source in development (Node strips types); the release is an esbuild bundle.
- Add tests with every change. Tests must be deterministic: fake Claude/Codex CLIs and real Git, never a real model.
- Safety rules are product features. A change that weakens a guard (confirmations, protected paths, sandbox, fail-closed behaviour) needs a test that proves the guard still holds.
- Do not claim something is verified unless a test or an observed run shows it; unknown stays `UNKNOWN`.
- Keep the core free of runtime dependencies. Windows, macOS and Linux CI must all pass.
- No API keys, tokens or personal files in code, tests or fixtures.
