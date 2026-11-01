# Development

```bash
pnpm install
pnpm check            # typecheck, lint, tests
pnpm cli <command>    # run from source
pnpm build            # dist/agent-control-lab.js (single bundled file)
pnpm pack:release     # release/agent-control-lab-<version>.tgz + .sha256
pnpm smoke:pack       # install that tarball in an empty folder and run it
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
