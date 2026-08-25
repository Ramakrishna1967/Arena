# Arena CLI — Architecture Design

Multi-provider agent CLI where agents "level up" from usage: prompt/strategy evolution + auto-generated SKILL.md-style skill files, gated by minimum repeated-success thresholds. No weight fine-tuning anywhere.

## 1. High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L5  CLI + PERSISTENCE                                                     │
│   commands · session resume/render · config · atomic state IO · lockfile  │
└──────▲───────────────────────────────────────────────────────▲───────────┘
      │ user intent / streamed render                          │ load/save state
┌──────┴───────────────────────────────────────────────────────┴───────────┐
│ L2  AGENT + SUB-AGENT EXECUTION CORE                                      │
│   Orchestrator ──spawn (depth ≤ 4, narrowed allowlist)──▶ Sub-Agents      │
│   Executor loop: plan ▸ act(shell/file/web/code) ▸ observe                │
│        │  emits TrajectoryEvent stream        ▲ binds immutable            │
│        │                                     │  PolicyBundle (per run)     │
└────────┼─────────────────────────────────────┼───────────────────────────┘
         │ append-only events                  │ v(N+1) activates NEXT session
┌────────▼──────────────────────────┐   ┌─────┴────────────────────────────┐
│ L3  TRAJECTORY LOG + ARBITER      │   │ L4  LEVELING + SKILL EVOLUTION    │
│  Recorder (JSONL per run)         │   │  Stats rollup (per profile)       │
│  Arbiter: hard checks ▸ rubric    │──▶│  Level gates (K-success, M-task)  │
│   judge via L1 "meta lane"        │   │  Skill miner / canary promoter    │
│  emits ScoreRecord {verdict}      │   │  Version lineage DAG + rollback   │
└───────────────────────────────────┘   └───────▲───────────────────────────┘
                                                │ candidate eval requests
┌───────────────────────────────────────────────┴───────────────────────────┐
│ L1  PROVIDER ABSTRACTION                                                   │
│   OpenAI · Anthropic · xAI · DeepSeek                                      │
│   → NormalizedStream{text_delta, tool_call, usage, finish}                 │
│   unified tool-call schema · retry/backoff taxonomy · cost accounting      │
└────────────────────────────────────────────────────────────────────────────┘

FEEDBACK LOOP:  L3 ScoreRecords ─▶ L4 gates/promotions ─▶ PolicyBundle ─▶ L2
```

## 2. Layers, Components, Boundaries

### L1 — Provider Abstraction
- **Adapter set (one per provider):** translates native SDK responses into a single `NormalizedStream`; classifies failures into `{transport_retryable, rate_limited, schema_violation, fatal}` with uniform backoff.
- **Tool-call canonicalizer:** maps each provider's tool-calling dialect (incl. parallel-call differences, JSON-schema strictness) onto one internal schema.
- **Does NOT own:** agent logic, tool execution semantics, retries driven by *strategy* (only transport-level), any state.

### L2 — Agent + Sub-Agent Execution Core
- **Orchestrator:** decomposes tasks, spawns scoped sub-agents, enforces hard depth cap (default 4) and propagates token/cost budgets down the tree.
- **Executor:** the act–observe tool loop against real shell/file/web/code tools with permission gating; binds exactly one immutable `PolicyBundle` per run.
- **Does NOT own:** scoring, leveling, skill content, provider selection policy beyond what the bundle specifies.

### L3 — Trajectory Logging + Arbiter
- **Recorder:** append-only JSONL of every step (`events.jsonl` per run) with parent links, hashes, token/cost — the sole write path during execution.
- **Arbiter:** post-run (and per-milestone) scoring in two stages — deterministic hard checks first, then rubric-based judge calls routed through L1 on a dedicated "meta" lane (separate model config, sees full trajectory, never grades blind). Emits an explicit, inspectable `ScoreRecord`.
- **Does NOT own:** mutating agent behavior, storing skills/stats, deciding promotions — it only publishes verdicts.

### L4 — Leveling + Skill Evolution Engine
- **Stats rollup:** folds ScoreRecords (root-weighted 1.0, sub-agent 0.5) into per-profile counters and rolling success rates.
- **Gatekeeper:** level-up requires ≥ K consecutive-window successes across ≥ M distinct task fingerprints at the current tier — structurally impossible to promote off one fluke.
- **Skill Miner/Promoter:** drafts SKILL.md candidates from high-scoring trajectories (LLM call via L1 meta lane), moves them `draft → candidate(canary) → active → retired`.
- **Version Lineage:** DAG of policy/skill versions with parent pointers; rollback = pointer flip, auto-triggered when canary cohort regresses below baseline − δ.
- **Does NOT own:** live-session behavior (it never touches a running agent), tool execution, direct provider traffic outside the meta lane.

### L5 — CLI + Persistence
- **Command surface / renderer / session resume**, plus the only code that touches disk: atomic write-temp-rename, global lockfile, JSONL append.
- **Does NOT own:** any business logic; it is a façade over L2–L4 services.

## 3. Resolved Design Decisions

**State lives on the filesystem, no database.** `~/.arena/` with:
- `runs/<id>/events.jsonl` + `score.json` — append-only, crash-safe, greppable
- `agents/<profile>/policy/vN.json` + `lineage.json`
- `skills/<id>/versions/*.md`
- `stats.json` — derived rollup, rebuildable from trajectories (event sourcing)
- `global.lock` — single writer

Rationale: inspectability is a core constraint; files are diffable, portable, git-friendly for lineage, and CLI-scale volume makes SQLite unnecessary overhead. Concurrency solved by lockfile, not a DB engine.

**Layer contracts:**

| Edge | Contract |
|---|---|
| L1→L2 | `NormalizedStream` events + typed error taxonomy |
| L2→L3 | `TrajectoryEvent` (append-only, parent-linked) |
| L3→L4 | `ScoreRecord` {rubric_version, hard_checks, judge_scores, verdict, confidence} |
| L4→L2 | `PolicyBundle` (immutable snapshot: policy_version, active skills, prompt overrides, allowlist, budgets) |

**Level-up propagation: queued, at session boundary.** Promotions land as a new policy version immediately but bind only to *new* runs. Within a session the bundle is frozen — this makes trajectories reproducible against a known version, which the Arbiter depends on for attribution.

**Rollback:** every mutation is a canary first. Canary cohorts (a fraction of eligible runs) run on the candidate; if rolling success drops below the active baseline − δ over window W, auto-rollback flips the lineage pointer to the parent version. Manual rollback always available. Nothing bypasses candidate status.

**Sub-agent inheritance:** inherits a *frozen snapshot* of the parent's active bundle with a strictly narrower tool allowlist and a child-share of the budget; depth+1 under the hard cap. Sub-agent scores roll up to the parent profile at 0.5 weight, but sub-agents never trigger level-ups and never mutate skills — evolution is a root-level privilege.

**Skill file shape:** Markdown body + YAML frontmatter:

```yaml
id: string
version: string
parent_version: string
status: draft | candidate | active | retired
triggers:
  path_globs: []
  keywords: []
  command_prefixes: []
token_cost: int
stats:
  uses: int
  success_rate: float
```

**Runtime trigger logic is deterministic-first:** frontmatter matchers evaluated against cwd/task-text/tool-history; top-k selected under a prompt-token budget; injected with a provenance header (skill id+version) so the Arbiter can attribute outcomes per skill — closing the measurement loop.

## 4. Failure Modes / Sharp Edges

1. **Reward hacking via judge bias.** The agent optimizes rubric artifacts instead of the task; a judge from the same model family shares blind spots, so gaming scores high and poisons promotions. Mitigations: hard checks precede judging, judge sees full trajectory (not just output), judge config independent of worker config.
2. **Skill bloat and contradiction.** Promoted skills accumulate until the prompt budget saturates and mutually conflicting advice degrades *all* tasks; because rollback lags detection, one poisoned candidate snapshots into every spawned sub-agent. Mitigations: hard injection budget, contradiction check at promotion time, retirement on low marginal lift.
3. **Misattributed scoring from provider normalization gaps.** Parallel-tool-call and schema-strictness differences mean a provider quirk surfaces as an agent failure; the Arbiter penalizes the wrong party and levels drift per-provider. Requires L1 to tag provider-attributable faults in the stream so the Arbiter can exclude them.
4. **Concurrent state corruption.** Two CLI sessions racing on `stats.json`/`lineage.json` lose updates silently; atomic rename protects single files, not multi-file invariants. Lockfile + rebuild-from-events is mandatory, not optional.
5. **Runaway fan-out cost.** Depth caps bound recursion, not spend — a breadth-3 subtree of sub-agents each inheriting generous budgets multiplies API cost quickly. Budgets must shrink geometrically per depth level and be enforced pre-call, not reconciled after.
