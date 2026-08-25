# L2.5 — Orchestrator + Sub-Agents

Scoped fan-out that cannot run away. `spawn_agent` is a regular tool call, so all
limits are enforced at one gate BEFORE any provider traffic happens.

## The spawn gate (pre-call, in order)

1. **Depth cap** — `depth + 1 > maxDepth` (bundle `budgets.maxDepth`, default 4) → denied.
   At the cap the tool is removed from the schema surface entirely: children cannot even offer it.
2. **Budget derivation** — child slice = floor(parentRemaining × shrink) for steps/tools/wall-clock,
   minus this spawn's own turn. Unusable slice (<1 step/tool or <250ms wall) → denied.
   Parent wall clock shrinks too, so deep trees cannot outlive their root deadline.
3. **Allowlist narrowing** — child gets `requested ∩ parent-effective` (+ `task_complete`,
   + `spawn_agent` only while headroom remains). Narrowing is monotonic: no child ever sees
   a tool its parent didn't have.

After the child finishes, its ACTUAL consumption (steps + tool calls) is charged back to the
parent ledger — later siblings inherit the true remaining budget.

## Trajectory linkage

Every event from every node carries `{runId, parentId?, depth}` stamped by the executor.
A run tree reconstructs exactly from a flat event stream; L3 records these as-is.

## Structure

- `ArenaOrchestrator.run(task, bundle, env)` → root node; recursion goes through
  per-run registry clones, so each node's `spawn_agent` closes over ITS OWN depth/ledger.
- `RunLedger` / `deriveChildBudgets` (`ledger.ts`) — pure accounting, unit-testable.
- Denials are model-readable tool results (`SPAWN DENIED: ...`) so agents adapt instead of crashing.

Known debt: parallel sibling spawns serialize today (each blocks its parent's turn); concurrent
fan-out lands with the CLI scheduler in Phase 6 if needed.
