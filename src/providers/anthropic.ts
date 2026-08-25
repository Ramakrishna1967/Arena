import { ProviderError } from './errors.js';
import { postForResponse } from './http.js';
import { parseSseStream } from './sse.js';
import type {
  CompletionRequest,
  ProviderAdapter,
  ProviderName,
  ResolvedProviderOptions,
  FinishReason,
  StreamEvent,
} from './types.js';

type ABlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AMessage {
  role: 'user' | 'assistant';
  content: ABlock[];
}

/**
 * Anthropic Messages API adapter. Key dialect differences handled here:
 * - system prompt is a top-level param (not a message)
 * - tool results are user-role `tool_result` blocks
 * - strict-ish role alternation -> consecutive same-role messages merge
 * - history may not open with an assistant turn -> synthetic user marker
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic';
  private readonly opts: ResolvedProviderOptions;

  constructor(opts: ResolvedProviderOptions) {
    this.opts = opts;
  }

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const body = toAnthropicRequest(req);
    const stream = req.stream !== false;
    const res = await postForResponse({
      provider: this.name,
      url: `${this.opts.baseUrl}/v1/messages`,
      headers: {
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      bodyJson: body,
      apiKey: this.opts.apiKey,
      fetchImpl: this.opts.fetchImpl,
      retry: this.opts.retry,
      signal: req.signal,
      timeoutMs: this.opts.timeoutMs,
    });

    if (stream) {
      if (!res.body) throw ProviderError.malformed(this.name, 'empty response body');
      yield* this.streamEvents(res.body);
      return;
    }

    let json: any;
    try {
      json = await res.json();
    } catch (e) {
      throw ProviderError.malformed(this.name, 'response JSON', String(e));
    }
    if (json?.error) throw classifyAnthropicError(json.error);
    yield* nonStreamingEvents(this.name, json);
  }

  private async *streamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    let inputTokens = 0;
    let outputTokens = 0;
    let finish: FinishReason = 'stop';

    interface OpenBlock {
      kind: 'text';
    }
    interface ToolBlock {
      kind: 'tool';
      id: string;
      name: string;
      json: string;
    }
    const blocks = new Map<number, OpenBlock | ToolBlock>();

    for await (const frame of parseSseStream(body)) {
      let d: any;
      try {
        d = JSON.parse(frame.data);
      } catch (e) {
        throw ProviderError.malformed(this.name, 'SSE data JSON', { data: frame.data.slice(0, 200), cause: String(e) });
      }
      switch (d?.type) {
        case 'message_start':
          inputTokens = Number(d.message?.usage?.input_tokens ?? 0);
          break;
        case 'content_block_start': {
          if (d.content_block?.type === 'tool_use') {
            blocks.set(d.index, {
              kind: 'tool',
              id: String(d.content_block.id),
              name: String(d.content_block.name),
              json: '',
            });
            yield { type: 'tool_call_start', index: d.index, id: String(d.content_block.id), name: String(d.content_block.name) };
          } else {
            blocks.set(d.index, { kind: 'text' });
          }
          break;
        }
        case 'content_block_delta': {
          if (d.delta?.type === 'text_delta') {
            yield { type: 'text_delta', delta: String(d.delta.text ?? '') };
          } else if (d.delta?.type === 'input_json_delta') {
            const b = blocks.get(d.index);
            if (b && b.kind === 'tool') {
              const frag = String(d.delta.partial_json ?? '');
              b.json += frag;
              yield { type: 'tool_call_delta', index: d.index, argsDelta: frag };
            }
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(d.index);
          if (b && b.kind === 'tool') {
            yield { type: 'tool_call_end', index: d.index, call: parseToolInput(this.name, b.id, b.name, b.json) };
          }
          break;
        }
        case 'message_delta':
          if (d.delta?.stop_reason) finish = mapStopReason(String(d.delta.stop_reason));
          if (d.usage?.output_tokens !== undefined) outputTokens = Number(d.usage.output_tokens);
          break;
        case 'message_stop':
          break;
        case 'ping':
          break;
        case 'error':
          throw classifyAnthropicError(d.error);
        default:
          break;
      }
    }

    yield { type: 'finish', reason: finish, usage: { inputTokens, outputTokens } };
  }
}

export function toAnthropicRequest(req: CompletionRequest): Record<string, unknown> {
  const system: string[] = req.system ? [req.system] : [];
  const msgs: AMessage[] = [];

  const push = (role: 'user' | 'assistant', block: ABlock): void => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      msgs.push({ role, content: [block] });
    }
  };

  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        if (m.text) system.push(m.text);
        break;
      case 'user':
        push('user', { type: 'text', text: m.text ?? '' });
        break;
      case 'assistant': {
        if (m.text) push('assistant', { type: 'text', text: m.text });
        for (const c of m.toolCalls ?? []) {
          push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        }
        break;
      }
      case 'tool': {
        const block: ABlock = {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.text ?? '',
          ...(m.isError ? { is_error: true } : {}),
        };
        push('user', block);
        break;
      }
    }
  }

  if (msgs.length === 0) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: req.system ?? '' }] });
  }
  // The Messages API requires the conversation to open with a user turn.
  if (msgs[0].role !== 'user') {
    msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(session resumed - continue)' }] });
  }

  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 1024,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages: msgs,
    ...(req.tools && req.tools.length > 0
      ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.parameters })) }
      : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: req.stream !== false,
  };
}

function nonStreamingEvents(provider: ProviderName, json: any): StreamEvent[] {
  const events: StreamEvent[] = [];
  const blocks: any[] = json?.content ?? [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'text') {
      events.push({ type: 'text_delta', delta: String(b.text ?? '') });
    } else if (b.type === 'tool_use') {
      events.push({ type: 'tool_call_start', index: i, id: String(b.id), name: String(b.name) });
      events.push({ type: 'tool_call_end', index: i, call: parseToolInput(provider, String(b.id), String(b.name), '', b.input) });
    }
  }
  events.push({
    type: 'finish',
    reason: json?.stop_reason ? mapStopReason(String(json.stop_reason)) : 'stop',
    usage: {
      inputTokens: Number(json?.usage?.input_tokens ?? 0),
      outputTokens: Number(json?.usage?.output_tokens ?? 0),
    },
  });
  return events;
}

function parseToolInput(
  provider: ProviderName,
  id: string,
  name: string,
  rawJson: string,
  fallbackObject?: Record<string, unknown>,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const trimmed = rawJson.trim();
  if (trimmed === '' || trimmed === '{}') {
    if (fallbackObject !== undefined) return { id, name, arguments: fallbackObject };
    return { id, name, arguments: {} };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { id, name, arguments: parsed as Record<string, unknown> };
  } catch (e) {
    throw ProviderError.malformed(provider, `tool arguments for ${name}`, { raw: trimmed.slice(0, 200), cause: String(e) });
  }
}

export function mapStopReason(r: string): FinishReason {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function classifyAnthropicError(err: any): ProviderError {
  const type = String(err?.type ?? '');
  const message = String(err?.message ?? 'unknown anthropic error');
  switch (type) {
    case 'overloaded_error':
    case 'api_error':
      return new ProviderError('transport_retryable', `${type}: ${message}`, {
        provider: 'anthropic',
        providerFault: true,
      });
    case 'invalid_request_error': {
      return ProviderError.fromHttpStatus('anthropic', 400, `${type} ${message}`);
    }
    case 'authentication_error':
    case 'permission_error':
    case 'not_found_error':
    case 'request_too_large':
      return new ProviderError('fatal', `${type}: ${message}`, {
        provider: 'anthropic',
        providerFault: false,
      });
    default:
      return new ProviderError('fatal', `${type || 'error'}: ${message}`, {
        provider: 'anthropic',
        providerFault: false,
      });
  }
}
