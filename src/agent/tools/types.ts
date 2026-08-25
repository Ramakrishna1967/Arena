import type { ToolResult } from '../types.js';

export type { ToolResult };

export type ToolKind = 'shell' | 'file' | 'web' | 'code' | 'builtin';

export interface ToolContext {
  /** Workspace root (jail root for file tools). */
  cwd: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}

export interface ArenaTool<A = Record<string, unknown>> {
  name: string;
  description: string;
  kind: ToolKind;
  parameters: Record<string, unknown>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export function toolError(output: string): ToolResult {
  return { ok: false, output };
}

export function toolOk(output: string, data?: unknown): ToolResult {
  return { ok: true, output, data };
}

/** Light arg validation with friendly errors the model can recover from. */
export function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${tool}: missing required string argument '${key}'`);
  }
  return v;
}
