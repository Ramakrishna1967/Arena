import type { ChatMessage, NormalizedToolCall, ProviderName, TokenUsage } from '../providers/types.js';

/**
 * L2 contracts. A PolicyBundle is an IMMUTABLE snapshot bound to exactly one
 * run (architecture decision: no mid-session swaps; L4 publishes new versions
 * that bind only to future runs).
 */

export type PermissionMode = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  tool: string;
  mode: PermissionMode;
  /** Regex SOURCE matched against the rule target (command / path / url). */
  pattern?: string;
}

export interface PermissionConfig {
  /** Applied when no rule matches. */
  default: PermissionMode;
  /** First matching rule wins - order is precedence. */
  rules: PermissionRule[];
}

export interface Budgets {
  /** Max provider round-trips. */
  maxSteps: number;
  /** Max tool executions per run. */
  maxToolCalls: number;
  /** Hard wall-clock cap for the whole run. */
  wallClockMs?: number;
  /** Hard spawn-depth cap (orchestrator); default handled by orchestrator. */
  maxDepth?: number;
}

export interface PolicyBundle {
  readonly id: string;
  readonly version: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxTokensPerTurn?: number;
  /** Empty array = every registered tool allowed. */
  readonly toolAllowlist: readonly string[];
  readonly permissions: PermissionConfig;
  readonly budgets: Budgets;
}

export type AskHandler = (req: PermissionRequest) => Promise<boolean>;

export interface PermissionRequest {
  tool: string;
  /** Matchable target: shell command / file path / url / '' for builtin. */
  target: string;
  args: Record<string, unknown>;
}

export type RunStatus = 'completed' | 'aborted' | 'budget_exhausted' | 'error';

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

/** Attribution metadata stamped onto every emitted event by the executor. */
export interface EventMeta {
  runId: string;
  /** Undefined for root runs. */
  parentId?: string;
  /** 0 for root runs. */
  depth: number;
}

type Distribute<T> = T extends unknown ? Omit<T, keyof EventMeta> : never;

type AgentEventBase =
  | { type: 'run_start'; task: string }
  | { type: 'step_start'; step: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: NormalizedToolCall; permitted: boolean }
  | {
      type: 'tool_result';
      callId: string;
      tool: string;
      ok: boolean;
      durationMs: number;
      /** Capped preview of the tool output so JSONL replay is self-contained. */
      output: string;
    }
  | { type: 'step_end'; step: number; usage?: TokenUsage }
  | { type: 'run_end'; status: RunStatus; finalText?: string; errorMessage?: string };

export type AgentEvent = AgentEventBase & EventMeta;

/** Event shape before the executor stamps meta - what emit callbacks receive internally. */
export type RawAgentEvent = Distribute<AgentEventBase>;

export interface RunResult {
  runId: string;
  status: RunStatus;
  finalText?: string;
  errorMessage?: string;
  steps: number;
  toolCallsExecuted: number;
  totalUsage?: TokenUsage;
  costUsd?: number;
  transcript: ChatMessage[];
}

export interface RunOptions {
  /** Workspace root; also the jail root for file tools. Default process.cwd(). */
  cwd?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  askHandler?: AskHandler;
  /** Orchestrator-assigned run id; generated when omitted. */
  runId?: string;
  /** Set by the orchestrator on spawned children for trajectory linkage. */
  parentRunId?: string;
  depth?: number;
}
