# Task / handoff packet

Schema version **1**, validated on write and on read (`validateHandoff`): unknown keys, wrong types, control characters, oversize
values and malformed ids are rejected.

```jsonc
{
  "schemaVersion": 1,
  "taskId": "t-0123456789ab",            // t- + 12 hex; also the file name, so path tricks are impossible
  "createdAt": "2026-11-01T10:00:00.000Z",
  "updatedAt": "…",
  "status": "created|running|completed|failed|cancelled|timeout|interrupted",
  "label": "plan-implement-review",       // short; the task prompt itself is never stored
  "project": { "root": "/abs/path", "name": "billing" },
  "scope": { "repoRoot": "…", "worktree": "…", "createdByTool": false },
  "git": { "head": "<sha>", "branch": "feature", "clean": true },
  "instructions": [{ "path": "…", "sha256": "…", "provider": "claude|codex" }],
  "plan": { "sha256": "…", "chars": 1234 },  // text only if explicitly retained
  "acceptance": ["…"],
  "changes":  [{ "path": "README.md", "status": "changed", "source": "verified|agent" }],
  "evidence": [{ "kind": "git-change|test|review", "source": "verified|agent", "summary": "…", "at": "…" }],
  "openItems": ["…"],
  "nextStage": "review",
  "stages": [{ "id": "plan", "provider": "claude", "status": "completed" }],
  "owner": { "pid": 1234 }
}
```

## Verified versus claimed

`source: "verified"` is set only by this tool, from Git or from a test command it ran. Anything a model said about itself is
`"agent"`. A `review` entry can never be `verified` (the validator rejects it). When a packet is shown to another agent
(`renderHandoffForAgent`) the verified section comes first, the claimed section is labelled, and the whole text is an untrusted block.

## What the run recorder fills

When a run starts, a `running` record with the owner process id is written first, so a crash leaves evidence. On finish the same record is
replaced: final status, stages, Git HEAD/branch/cleanliness, changed paths and test/inspection results as `verified`, a
review as `agent`. `instructions`, `plan`, `acceptance` and `nextStage` are part of the schema for tools that supply them; the built-in
recorder leaves them empty rather than storing text.

## Persistence

`<data dir>/tasks/<id>.json`, mode 0600, written to a temporary file and renamed. At most 200 records (oldest pruned, only this
store's own files), 256 KiB each. `tasks` lists, `tasks show <id>` prints, `tasks forget <id>` and `tasks clear` delete.

## Crash, cancel, timeout, restart

A task recorded as `running` whose owner process no longer exists is shown as `interrupted` (its running stage as `failed`); the file is
not rewritten. Cancel and timeout are recorded as such. Corrupt, oversized and newer-schema files are listed as unreadable and never used.

## Resume

`tasks resume-check <id>` ignores the stored state and asks Git again. It reports `head-changed`, `branch-changed`, `worktree-dirty`
(clean at record time, dirty now), `stale` (older than 7 days), `already-finished`, or `running-elsewhere`. Only an empty list
means "safe to continue". The tool never resumes a run by itself.
