# Arena CLI — Build Roadmap (6 Phases)

Stack decision (opinionated): **TypeScript on Node ≥ 20** — all four providers ship first-class TS SDKs, rich CLI ecosystem (commander/yargs, ink optional), single-binary distribution via Bun/esbuild later.

Order follows data flow: nothing scores what doesn't run; nothing levels up without scores.

---

## Phase 1: Provider Abstraction Layer (L1) — ✅ COMPLETE
**Goal:** One interface, four providers, zero leakage of provider quirks upstream.

- `NormalizedStream` event model: `{text_delta, tool_call{id,name,args}, usage, finish{reason}}`
- Adapters: OpenAI, Anthropic, xAI, DeepSeek
- Tool-call canonicalizer (parallel calls, strict-schema differences → internal schema)
- Error taxonomy: `{transport_retryable, rate_limited, schema_violation, fatal}` + uniform backoff
- Provider-attributable fault tagging (feeds Arbiter exclusion rule later)
- Cost/token accounting per call

**Exit criteria:** Same scripted multi-turn tool-calling scenario produces equivalent normalized event streams across all 4 providers; contract tests per adapter pass; injected failures retry/classify correctly.

**Delivered (2026-08-25):**
- `src/providers/` — types (`StreamEvent`, `ChatMessage`, `ProviderError` taxonomy with `providerFault` tagging), SSE parser, retry/backoff, cost accounting, OpenAI-compatible base + OpenAI/xAI/DeepSeek adapters, Anthropic adapter, registry
- `tests/contract/` — per-provider contract tests + `equivalence.test.ts` proving identical normalized transcripts across all 4 providers against canned wire traffic; error-path contracts (429 retry, 5xx exhaustion, schema-400 classification)
- `tests/unit/` — SSE edge cases, retry semantics, error matrix, pricing, message mappings, registry
- **50/50 tests passing, tsc strict clean.** Contract docs: `src/providers/README.md`

## Phase 2: Agent Execution Core (L2) — single agent — ✅ COMPLETE
**Goal:** A real agent that does real work through tools, bound to an immutable config.

- Executor loop: plan ▸ act ▸ observe
- Tool registry + implementations: shell (permission-gated), file read/write/edit, web fetch/search, code eval sandbox
- Permission gating model (allowlist/ask/deny)
- `PolicyBundle` binding: exactly one immutable bundle per run
- Run lifecycle: init, stream render hooks, abort/cleanup

**Exit criteria:** Agent completes multi-step file+shell tasks end-to-end against one provider; permission gate blocks unapproved shell commands; clean Ctrl-C semantics.

**Delivered (2026-08-25):**
- `src/agent/` — `executor.ts` (plan▸act▸observe loop, budgets, abort/wall-clock plumbing, cost rollup), `policy.ts` (`defineBundle` deep-freeze, `starterBundle`), `permissions.ts` (ordered rules, pattern targets per tool kind, fail-closed ask), `tools/` (shell w/ tree-kill, jailed file ops, web_fetch caps, code_eval subprocess, task_complete) + registry
- `tests/agent/` — exit-criteria scenarios proven: multi-step file+shell E2E with model observing real tool results; permission denial fed back as data (command never ran); Ctrl-C abort < 3s with clean status; budget exhaustion; task_complete termination
- **73/73 tests passing, tsc strict clean.** Contract docs: `src/agent/README.md`
- Known debt logged: code_eval network sandboxing, grandchild-process cleanup edges → Phase 6 hardening

## Phase 3: Orchestrator + Sub-Agents — ✅ COMPLETE
**Goal:** Scoped fan-out that cannot run away.

- Task decomposition + spawn protocol
- Hard depth cap (default 4) enforced at spawn time
- Budget inheritance: geometric shrink per depth, enforced pre-call
- Frozen-bundle snapshots + narrowed tool allowlists for children
- Parent-linked trajectory emission (`parent_run_id`)

**Exit criteria:** Recursive self-spawn terminates at cap; budget exhaustion kills subtree gracefully; child trajectories correctly parent-linked and attributable.

**Delivered (2026-08-25):**
- `src/orchestrator/` — `orchestrator.ts` (`ArenaOrchestrator`, per-run registry clones with depth-scoped `spawn_agent`), `ledger.ts` (`RunLedger` + geometric-shrink `deriveChildBudgets`, wall-clock propagation, 250ms usability floor), `spawn-protocol.ts` (args parsing, child summaries)
- Spawn gate enforced pre-call in order: depth cap → budget slice → monotonic allowlist narrowing; actual child consumption charged back to parent ledger for siblings
- Every AgentEvent now stamped `{runId, parentId?, depth}` — full tree reconstructs from flat event stream
- `tests/orchestrator/` — exit criteria proven: self-spawn chain terminates at depth 2 with spawn tool absent from leaf schema surface; burned subtree ends `budget_exhausted` and parent model receives explicit status; parent-linked attribution across all events; narrowed allowlist denies unrequested tools
- **83/83 tests passing, tsc strict clean.** Contract docs: `src/orchestrator/README.md`
- Debt logged: parallel sibling spawns serialize today → revisit in Phase 6 if needed

## Phase 4: Trajectory Logging + Arbiter (L3) — ✅ COMPLETE
**Goal:** Every run leaves evidence; every verdict is explicit and inspectable.

- Recorder: append-only `events.jsonl` per run (+ `score.json`)
- Deterministic hard checks (exit codes, tests, file assertions) evaluated before judging
- Rubric engine: versioned rubric files, dimension scoring
- Judge lane: separate model config via L1 meta lane, sees full trajectory, provider-fault exclusion applied
- `ScoreRecord` output contract

**Exit criteria:** Replay any past run from JSONL alone; identical run re-scores deterministically for hard-check stage; rubric versions pinned in every score.

**Delivered (2026-08-25):**
- `src/recorder/` — append-only `events.jsonl` per run dir + `meta.json` + `scores/`; passthrough sink; `loadEvents` replay with line-numbered corruption errors; trajectory/tree reconstruction from flat stream
- Events extended for self-contained replay: `run_start.task`, `tool_result.output` (capped preview)
- `src/arbiter/` — versioned deterministic hard checks (`run_completed`, `tolerable_tool_failures`, ...); rubric engine (JSON files, weight-sum validation, unknown-check rejection, shipped default v1.0.0); judge meta-lane (`llmJudge` with separate provider/model config) + injectable `JudgeFn`; two-stage pipeline with explicit ordered verdict rules
- Provider-fault exclusion: infrastructure failures → verdict `inconclusive` + `provider_fault:*` excluded from agent stats
- `tests/arbiter/` — exit criteria proven: JSONL roundtrip replay; byte-identical re-score with fixed clock; rubric version pinned verbatim; hard-fail decisive with judge never called; provider fault → inconclusive; judge-lane outage degrades gracefully
- **91/91 tests passing, tsc strict clean.** Contract docs: `src/arbiter/README.md`

## Phase 5: Leveling + Skill Evolution Engine (L4) — ✅ COMPLETE
**Goal:** Improvement that cannot be faked by a lucky run.

- Stats rollup (root 1.0 / sub-agent 0.5 weighting), rolling success rates
- Level gates: ≥ K successes across ≥ M distinct task fingerprints
- Skill miner: draft SKILL.md candidates from high-scoring trajectories (meta lane LLM calls)
- Promotion pipeline: `draft → candidate(canary cohort) → active → retired`
- Version lineage DAG + pointer-flip rollback (auto on regression − δ over window W)
- Token-budgeted deterministic skill trigger matching

**Exit criteria:** Single success never promotes (forced test); forced regression triggers auto-rollback; lineage DAG reconstructs full history of any skill/policy.

**Delivered (2026-08-25):**
- `src/leveling/` — `StatsEngine` (root 1.0 / child 0.5 weights, inconclusive excluded, rolling window, task fingerprints), `gates.ts` (K×M×rate — single success structurally cannot promote), `skill-store.ts` (SKILL.md + canonical skill.json, version DAG with parent edges + per-version outcome windows), `selector.ts` (deterministic trigger matching, token-budget packing, canary rolls), `policy.ts` (pointer-flip generations + injection ledger), `miner.ts` (injectable MinerFn + LLM impl), `promotion.ts` (contradiction gate Jaccard>0.6; regression sweep auto-rollback δ=0.2 under baseline, floor 0.3, ≥5 uses)
- `engine.ts` facade: ingest → credit → gate → promote-with-history; selectForRun → ledger; mineFromRun → draft; sweep → rollback events
- `tests/leveling/` — exit criteria proven end-to-end: 1 success blocked / grinding blocked by variety gate / rate collapse blocked; promotion fires at real evidence with history line; mined skill → candidate contradiction-blocked duplicate; forced failure window triggers pointer-flip rollback with lineage preserving every status
- **100/100 tests passing, tsc strict clean.** Contract docs: `src/leveling/README.md`
- Debt logged: parallel skill attribution when multiple skills injected per run (v1 credits all); YAML frontmatter is generated-only (canonical data in skill.json)

## Phase 6: CLI Surface, Persistence Hardening, Distribution (L5)
**Goal:** Ship it as a tool people install.

- Full command surface: run/resume, skills CRUD + inspect, arbiter report (`why`), level/status, rollback
- Persistence layer finalization: atomic writes, global lockfile, rebuild-from-events
- Session resume + rendering polish
- Failure-mode mitigations audit (skill bloat budget, contradiction checks, provider misattribution tags wired end-to-end)
- Packaging: single-binary builds, config docs, onboarding (`arena init`)

**Exit criteria:** Two concurrent sessions safe under lockfile; cold-start resume works; E2E demo: fresh install → task run → skill mined → promoted after threshold → visible behavior change next session.
