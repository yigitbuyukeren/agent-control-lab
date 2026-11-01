# Example tasks

## 1. Only Codex, small fix, no worktree gymnastics

```bash
agent-control-lab worktree create --repo ~/code/app --confirm        # prints the worktree path
agent-control-lab orchestrate --workflow plan-implement-review \
  --task "Fix the off-by-one in pagination and add a test" --workspace <path> \
  --step-provider plan=codex --step-provider implement=codex --step-provider review=codex --dry-run
```

## 2. Read-only second opinion (nothing is written)

```bash
agent-control-lab orchestrate --workflow plan-review --task "Is moving sessions to Redis worth it?" --cwd ~/code/app --confirm
```

## 3. Pass project conventions on, check them first

```bash
agent-control-lab instructions --cwd ~/code/app --context      # see exactly what would be passed
agent-control-lab orchestrate … --with-instructions --dry-run
```

## 4. Tests in the sandbox

```bash
agent-control-lab orchestrate --workflow plan-implement-review --task "…" --workspace <path> \
  --verify-command "node --test" --confirm-verify --dry-run     # shows "sandbox: macOS sandbox-exec, checked just now" or NONE
```

## 5. After an interruption

```bash
agent-control-lab tasks
agent-control-lab tasks resume-check t-0123456789ab
git -C <worktree> status && git -C <worktree> diff
```
