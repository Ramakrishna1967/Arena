# L3 — Trajectory Logging + Arbiter

Every run leaves evidence; every verdict is explicit and inspectable.

## Recorder (`src/recorder/`)

One directory per root run under the arena state root:

```
<runDir>/
  events.jsonl   flat stream - root AND children interleaved,
                 every line self-describing ({runId, parentId?, depth})
  meta.json      wall-clock summary (rootRunId, startedAt, endedAt, status)
  scores/        ScoreRecords written by the Arbiter
```

- `rec.sink()` is a passthrough for `RunOptions.onEvent` - attaching it can never change behavior.
- `loadEvents(dir)` replays any run from JSONL alone; corrupted lines throw with line numbers.
- Events carry enough payload to be self-contained: `run_start.task`, text deltas, tool args,
  capped `tool_result.output` previews.
- `buildTrajectoryView(events, runId)` rebuilds one node's steps/calls/results;
  `treeNodes(events)` summarizes the whole spawn tree.

## Arbiter (`src/arbiter/`)

A distinct component - scoring is never implicit. Two stages:

1. **Hard checks** (`checks.ts`) - versioned, deterministic, pure functions of the trajectory.
   Built-ins: `run_completed`, `tolerable_tool_failures`, `no_permission_denials`, `produced_final_answer`.
2. **Judge** - ONLY consulted when hard checks pass (hard fail = decisive; saves money).
   Default lane: separate provider/model config via `llmJudge()` (temperature 0, strict JSON),
   injectable as any `JudgeFn` for tests or rule-only setups.

### Verdict rules (ordered, explicit)

| Condition | Verdict | Confidence |
|---|---|---|
| run error matches provider-fault patterns | `inconclusive` | 0.95 |
| any hard check failed | `fail` | 0.99 |
| judge weighted overall ≥ 0.70 | `success` | 0.75 |
| judge weighted overall ≥ 0.40 | `partial` | 0.75 |
| below 0.40 | `fail` | 0.75 |
| no judge available + hard pass | `success` | 0.35 (low) |

- Provider-attributable failures (rate limits, upstream 5xx, timeouts, unnormalizable responses)
  are EXCLUDED from agent stats - infrastructure is not incompetence.
- Judge-lane failures degrade gracefully to hard-only with a `judge_error:` exclusion note.
- Rubrics are versioned JSON files in `<arenaRoot>/rubrics/<name>.json`; weights must sum to ~1;
  unknown check names are config errors, not silent passes. Every ScoreRecord pins
  `{name, version}` verbatim.
- L4 will consume ONLY `ScoreRecord`s from here.
