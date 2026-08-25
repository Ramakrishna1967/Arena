# L4 — Leveling + Skill Evolution Engine

The ONLY component that mutates leveling state. Consumes `ScoreRecord`s from the
Arbiter (L3); never touches live sessions; mining goes through an injectable
`MinerFn` on the offline meta lane.

## On-disk layout (`<arenaRoot>/`)

```
agents/<profile>/stats.json           level, totals, rolling window (cap 20),
                                      successesSinceLevelUp, task fingerprints
agents/<profile>/level-history.jsonl  one line per promotion (fromLevel/toLevel/evidence)
agents/<profile>/skill-ledger.jsonl   {runId, skillId, version} injection records
skills/<id>/skill.json                canonical machine-readable data
skills/<id>/SKILL.md                  human-readable rendering of skill.json + body
skills/<id>/versions/vN.md            immutable version bodies
skills/<id>/lineage.json              DAG: version -> {parent, status, stats}
policy/current.json                   POINTER: {genId, activeSkillVersions{}}
policy/history.jsonl                  every pointer flip, ever
```

## Level gate (defaults K=3, M=2, rate>=0.7)

ALL required: weighted successes at tier >= K **and** >= M DISTINCT task fingerprints
**and** rolling rate >= minRate. Root outcomes weigh 1.0, sub-agent 0.5;
`inconclusive` (provider faults) weighs nothing. A single success is structurally
unable to promote.

## Skill lifecycle

```
draft --(contradiction gate)--> candidate --(canary exposure)--> active --(regression)--> rolled_back
                                                                    \--(manual/obsolete)--> retired
```

- **Canary**: candidates are injected only when a deterministic per-run roll
  (< canaryPercent, default 20%) fires - evidence accumulates without mid-session swaps.
- **Injection ledger**: every selection is recorded per runId; joining with ScoreRecords
  gives each version its own uses/successes window - the measurement loop.
- **Regression sweep**: active version whose windowed success rate falls more than delta
  (0.2) under the global baseline (floored at 0.3) after >= 5 credited uses triggers
  AUTO-ROLLBACK: policy pointer flips to the parent version (or drops the entry),
  statuses flip, lineage history preserved forever.
- **Contradiction gate**: keyword-Jaccard > 0.6 against any ACTIVE skill blocks candidacy.

## Runtime selection

Deterministic-first matching: keyword hits in task text (+1 each), path glob hit (+2),
command prefix hit (+2), trigger-less skills act as low-priority background guidance.
Top matches packed greedily under the token budget (~4 chars/token estimate).
