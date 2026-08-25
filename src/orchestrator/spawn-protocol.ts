import type { AgentEvent, AskHandler } from '../agent/types.js';
import type { RunResult } from '../agent/types.js';

export interface SpawnEnv {
  cwd?: string;
  signal?: AbortSignal;
  askHandler?: AskHandler;
  /** Root-level event sink; every child event flows here tagged with meta. */
  onEvent?: (e: AgentEvent) => void;
}

export interface SpawnArgs {
  task: string;
  system?: string;
  /** Requested tool subset; intersected with parent's effective allowlist. */
  tools?: string[];
  label?: string;
}

export function parseSpawnArgs(raw: Record<string, unknown>): SpawnArgs | string {
  if (typeof raw.task !== 'string' || raw.task.trim().length === 0) {
    return 'spawn_agent: required string argument "task" is missing or empty';
  }
  const tools = raw.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string'))) {
    return 'spawn_agent: "tools" must be an array of tool-name strings';
  }
  return {
    task: raw.task as string,
    ...(typeof raw.system === 'string' ? { system: raw.system } : {}),
    ...(Array.isArray(tools) ? { tools: tools as string[] } : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  };
}

/** Compact, model-readable summary of what the child did. */
export function summarizeChildRun(args: SpawnArgs, r: RunResult): string {
  const lines = [
    `[spawn_agent] ${args.label ?? 'child'} (${r.runId}) finished status=${r.status}`,
    `steps=${r.steps} tool_calls=${r.toolCallsExecuted}${r.totalUsage ? ` tokens=${r.totalUsage.inputTokens}in/${r.totalUsage.outputTokens}out` : ''}${r.costUsd !== undefined ? ` cost=$${r.costUsd}` : ''}`,
  ];
  if (r.errorMessage) lines.push(`error: ${r.errorMessage}`);
  if (r.finalText) lines.push(`final output:\n${r.finalText}`);
  return lines.join('\n');
}
