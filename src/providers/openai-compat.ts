import { ProviderError } from './errors.js';
import { postForResponse } from './http.js';
import { parseSseStream } from './sse.js';
import type {
  ChatMessage,
  CompletionRequest,
  NormalizedToolCall,
  ProviderAdapter,
  ProviderName,
  ResolvedProviderOptions,
  FinishReason,
  StreamEvent,
  TokenUsage,
} from './types.js';

interface PendingCall {
  id?: string;
  name?: string;
  args: string;
  started: boolean;
}

/**
 * Base for OpenAI chat-completions dialect (OpenAI, xAI, DeepSeek).
 *
 * Retry boundary: transport retries cover connection + status. Once SSE
 * headers arrive we never replay; mid-stream failures surface as errors
 * for the Agent Core to handle.
 */
export abstract class OpenAICompatibleAdapter implements ProviderAdapter {
  abstract readonly name: ProviderName;
  protected readonly opts: ResolvedProviderOptions;

  constructor(opts: ResolvedProviderOptions) {
    this.opts = opts;
  }

  protected abstract get endpointPath(): string;

  protected extraHeaders(): Record<string, string> {
    return {};
  }

  /** Hook for subclass quirks (e.g. DeepSeek reasoning models). */
  protected amendBody(_req: CompletionRequest, body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    if (req.stream === false) {
      yield* this.completeNonStreaming(req);
      return;
    }
    const body = this.amendBody(req, this.buildBody(req, true));
    const res = await postForResponse({
      provider: this.name,
      url: `${this.opts.baseUrl}${this.endpointPath}`,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, ...this.extraHeaders() },
      bodyJson: body,
      apiKey: this.opts.apiKey,
      fetchImpl: this.opts.fetchImpl,
      retry: this.opts.retry,
      signal: req.signal,
      timeoutMs: this.opts.timeoutMs,
    });

    if (!(res.body)) throw ProviderError.malformed(this.name, 'empty response body');

    let finish: FinishReason | undefined;
    let usage: TokenUsage | undefined;
    const pending = new Map<number, PendingCall>();

    const ensureStarted = function* (index: number, p: PendingCall): Generator<StreamEvent> {
      if (!p.started && p.id && p.name) {
        p.started = true;
        yield { type: 'tool_call_start', index, id: p.id, name: p.name };
      }
    };

    for await (const frame of parseSseStream(res.body)) {
      if (frame.data.trim() === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(frame.data);
      } catch (e) {
        throw ProviderError.malformed(this.name, 'SSE data JSON', { data: frame.data.slice(0, 200), cause: String(e) });
      }
      if (chunk?.error) {
        throw classifyEnvelopeError(this.name, chunk.error);
      }
      if (chunk?.usage) usage = mapUsage(chunk.usage);

      const choice = chunk?.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text_delta', delta: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const index: number = tc.index ?? 0;
        const p = pending.get(index) ?? { args: '', started: false };
        pending.set(index, p);
        if (tc.id && !p.id) p.id = tc.id;
        const fname: string | undefined = tc.function?.name;
        if (fname && !p.name) p.name = fname;
        const frag: string | undefined = tc.function?.arguments;
        if (frag) p.args += frag;
        // Some compat providers split id and name across fragments; start is
        // deferred until both are known so downstream sees a valid call.
        yield* ensureStarted(index, p);
      }

      if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason);
    }

    // Flush any calls whose name/id arrived late or never got closed.
    const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, p] of ordered) {
      if (!p.started) {
        if (!p.name) throw ProviderError.malformed(this.name, 'tool_call without a name', { index });
        yield { type: 'tool_call_start', index, id: p.id ?? `synth_${index}`, name: p.name };
      }
      yield { type: 'tool_call_end', index, call: parseArgs(this.name, p.id ?? `synth_${index}`, p.name!, p.args) };
    }

    yield { type: 'finish', reason: finish ?? 'stop', usage };
  }

  private async *completeNonStreaming(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const res = await postForResponse({
      provider: this.name,
      url: `${this.opts.baseUrl}${this.endpointPath}`,
      headers: { authorization: `Bearer ${this.opts.apiKey}`, ...this.extraHeaders() },
      bodyJson: this.buildBody(req, false),
      apiKey: this.opts.apiKey,
      fetchImpl: this.opts.fetchImpl,
      retry: this.opts.retry,
      signal: req.signal,
      timeoutMs: this.opts.timeoutMs,
    });
    let json: any;
    try {
      json = await res.json();
    } catch (e) {
      throw ProviderError.malformed(this.name, 'response JSON', String(e));
    }
    if (json?.error) throw classifyEnvelopeError(this.name, json.error);

    const choice = json?.choices?.[0];
    if (!choice) throw ProviderError.malformed(this.name, 'response without choices', json);

    const text: string | null = choice.message?.content ?? null;
    if (text) yield { type: 'text_delta', delta: text };

    const calls: any[] = choice.message?.tool_calls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const name: string | undefined = c.function?.name;
      if (!name) throw ProviderError.malformed(this.name, 'tool_call without a name', c);
      yield { type: 'tool_call_start', index: i, id: c.id ?? `synth_${i}`, name };
      yield {
        type: 'tool_call_end',
        index: i,
        call: parseArgs(this.name, c.id ?? `synth_${i}`, name, c.function?.arguments ?? ''),
      };
    }
    yield {
      type: 'finish',
      reason: choice.finish_reason ? mapFinishReason(choice.finish_reason) : 'stop',
      usage: json.usage ? mapUsage(json.usage) : undefined,
    };
  }

  private buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: mapMessagesToOpenAI(req),
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    return body;
  }
}

export function mapMessagesToOpenAI(req: CompletionRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system !== undefined && req.system.length > 0) {
    out.push({ role: 'system', content: req.system });
  }
  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.text ?? '' });
        break;
      case 'user':
        out.push({ role: 'user', content: m.text ?? '' });
        break;
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.text ?? null };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
        }
        out.push(msg);
        break;
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId ?? '',
          ...(m.name ? { name: m.name } : {}),
          content: m.text ?? '',
        });
        break;
    }
  }
  return out;
}

function classifyEnvelopeError(provider: ProviderName, err: any): ProviderError {
  const message = String(err?.message ?? 'unknown provider error');
  const code = String(err?.code ?? err?.type ?? '');
  if (/rate.?limit/i.test(code) || /rate.?limit/i.test(message)) {
    return new ProviderError('rate_limited', message, { provider, providerFault: true });
  }
  return ProviderError.fromHttpStatus(provider, 400, `${code} ${message}`);
}

export function mapFinishReason(r: string): FinishReason {
  switch (r) {
    case 'stop':
    case 'natural':
      return 'stop';
    case 'tool_calls':
    case 'function':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapUsage(u: any): TokenUsage {
  return {
    inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
  };
}

export function parseArgs(
  provider: ProviderName,
  id: string,
  name: string,
  raw: string,
): NormalizedToolCall {
  const trimmed = raw.trim();
  if (trimmed === '') return { id, name, arguments: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return { id, name, arguments: parsed as Record<string, unknown> };
  } catch (e) {
    throw ProviderError.malformed(provider, `tool arguments for ${name}`, { raw: trimmed.slice(0, 200), cause: String(e) });
  }
}
