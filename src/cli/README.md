# L5 — CLI + Persistence (ArenaApp + `arena` binary)

Thin shell over the layers; zero business logic. Two entry surfaces:

- **`ArenaApp`** (`src/app.ts`) - programmatic session object; tests and future
  TUIs use this directly with injected adapters/stubs (no network needed).
- **`arena` CLI** (`src/cli/main.ts`) - zero-dependency argv parsing, plain
  stdout/stderr rendering, exit codes: 0 ok / 1 run-not-completed / 2 usage error.

## Commands

```
arena init                                   layout at ~/.arena + config.json
arena run "task" --provider p --model m      full loop: select skills -> run ->
                                             record -> score -> level ingest
arena resume <runDir> "follow-up"            cold-start from events.jsonl alone
arena status | runs                          level/stats/actives | run history
arena skills list|show|promote|retire        skill lifecycle
arena why <runDir>                           dump ScoreRecords next to evidence
```

## Session mechanics

- **Skill injection**: deterministic selection at session start; matched skills are
  rendered into the bound system prompt under "Active Skills" - that is the visible
  behavior lever the evolution engine pulls.
- **Resume**: `rebuildMessages()` reconstructs the full provider conversation from
  JSONL in a brand-new process (`seedMessages` on RunOptions); nothing else is needed.
- **Run artifacts**: every run lands in `<arenaRoot>/runs/<runId>/` with
  `events.jsonl`, `meta.json`, `scores/`.

## Concurrency model

Append-only per-run files make recording safe without coordination. All STATE
MUTATIONS (scoring ingest, promotions, rollbacks) go through `withArenaLock`
(`FileLock`: O_EXCL create, pid stamping, stale-lock steal after 30s, bounded
wait). Provider calls are never serialized by the lock.

## Packaging

`npm run build` -> `dist/` (NodeNext emit); `package.json#bin` maps `arena` to
`dist/cli/main.js`. Direct-execution bootstrap compares realpath of argv[1] with
this module - importing stays side-effect-free.
