# L2 — Agent Execution Core

The plan ▸ act ▸ observe loop plus real tools and permission gates. One immutable
`PolicyBundle` binds per run — no mid-run swaps (L4 publishes versions that bind only to future runs).

## Run flow

```ts
const executor = new AgentExecutor(createProvider('openai'), defaultRegistry(),
                                   new PermissionManager(bundle.permissions, askHandler));
const result = await executor.run('fix the failing test', bundle, {
  cwd: workspaceRoot,
  signal: ctrlC.signal,
  onEvent: e => render(e),   // run_start/step_start/text/tool_call/tool_result/step_end/run_end
});
// result: { status: completed|aborted|budget_exhausted|error, finalText, totalUsage, costUsd, transcript }
```

- **Loop**: stream one provider turn → forward text deltas → collect tool calls → authorize each → execute → append `tool` messages → repeat until plain stop, `task_complete`, budget, or abort.
- **Abort plumbing**: external signal AND wall-clock budget feed an internal controller shared by the provider request and every in-flight tool; shell/code children are killed via process-tree kill (`taskkill /T /F` on Windows).
- **Denials are data**: blocked tools return a PERMISSION DENIED tool-result so the model adapts instead of crashing.
- Budgets enforced pre-call: `maxSteps`, `maxToolCalls`, `wallClockMs`.

## Tools (all jailed / capped)

| Tool | Kind | Notes |
|---|---|---|
| `run_command` | shell | OS shell, output cap 100KB, timeout kill via tree-kill |
| `read_file` / `write_file` / `edit_file` / `list_dir` | file | path jail: everything must resolve inside the workspace root |
| `web_fetch` | web | http(s) only, 256KB body cap |
| `code_eval` | code | fresh node subprocess via stdin (no Windows cmdline limits), timeout kill |
| `task_complete` | builtin | explicit terminal signal; summary becomes finalText |

## Permissions

Ordered rules `{tool, mode: allow|ask|deny, pattern?}` against the kind-specific target
(command / path / url). First match wins → else config default. `ask` requires a handler;
without one we fail CLOSED. Known debt: sandboxing of code_eval network access, and
grandchild-process cleanup edge cases — both scheduled for hardening in Phase 6.
