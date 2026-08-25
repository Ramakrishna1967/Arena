/**
 * L1 Provider Abstraction - canonical contracts.
 *
 * Everything upstream (Agent Core L2) consumes ONLY these types. Provider
 * wire formats must never leak past the adapters.
 */
import type { ProviderError } from './errors.js';

export type ProviderName = 'openai' | 'anthropic' | 'xai' | 'deepseek';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A parsed tool-call arguments object. Adapters JSON.parse model output. */
export type ToolArguments = Record<string, unknown>;

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: ToolArguments;
}

/**
 * Canonical conversation message. Flat shape on purpose: each adapter maps
 * to/from its provider dialect (e.g. Anthropic tool_result blocks).
 */
export interface ChatMessage {
  role: Role;
  /** Text content for system/user/assistant; result text for role='tool'. */
  text?: string;
  /** Assistant-issued tool calls (role='assistant'). */
  toolCalls?: NormalizedToolCall[];
  /** For role='tool': id of the call this message answers. */
  toolCallId?: string;
  /** For role='tool': optional tool name for providers that want it. */
  name?: string;
  /** For role='tool': marks an errored tool execution. */
  isError?: boolean;
}

export interface ToolSchema {
  name: string;
  description?: string;
  /** JSON Schema object describing parameters. */
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';

/**
 * Normalized stream events. Errors are NOT events - they throw `ProviderError`
 * out of the iterator. Exactly one `finish` event is emitted on success.
 */
export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | { type: 'tool_call_end'; index: number; call: NormalizedToolCall }
  | { type: 'finish'; reason: FinishReason; usage?: TokenUsage };

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** Top-level system prompt; adapters place it per provider convention. */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Default true. */
  stream?: boolean;
  signal?: AbortSignal;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryOptions;
}

/** Fully resolved construction options handed to adapters by the registry. */
export interface ResolvedProviderOptions extends ProviderOptions {
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  complete(req: CompletionRequest): AsyncIterable<StreamEvent>;
}
