# agent-control-lab

A TypeScript monorepo for experimenting with agent control tooling. Currently a minimal, working CLI skeleton.

## Layout

- `apps/cli`: command-line entry point
- `packages/core`: core logic
- `packages/shared`: shared types and helpers

## Development

Requires Node.js 24+ and pnpm.

```bash
pnpm install
pnpm check        # typecheck, lint, test
pnpm cli info
```

## License

MIT
