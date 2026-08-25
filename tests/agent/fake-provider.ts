import type {
  ChatMessage,
  CompletionRequest,
  NormalizedToolCall,
  ProviderAdapter,
  ProviderName,
  StreamEvent,
  TokenUsage,
} from '../../src/providers/types.js';

export interface ScriptedTurn {
  text?: string;
  calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finish?: 'stop' | 'tool_calls';
  usage?: TokenUsage;
  /** When set, the turn's stream hangs until the request signal aborts. */
  hangUntilAbort?: boolean;
}

function turnEvents(t: ScriptedTurn): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (t.text) events.push({ type: 'text_delta', delta: t.text });
  t.calls?.forEach((c, i) => {
    events.push({ type: 'tool_call_start', index: i, id: c.id, name: c.name });
    events.push({
      type: 'tool_call_end',
      index: i,
      call: { id: c.id, name: c.name, arguments: c.arguments } satisfies NormalizedToolCall,
    });
  });
  events.push({ type: 'finish', reason: t.finish ?? (t.calls?.length ? 'tool_calls' : 'stop'), usage: t.usage });
  return events;
}

/**
 * Deterministic provider for executor tests. Records every request so tests
 * can assert the model actually observed tool results in the transcript.
 */
export class ScriptedProvider implements ProviderAdapter {
  readonly name: ProviderName = 'openai';
  public requests: CompletionRequest[] = [];
  private turnIndex = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(structuredCloneish(req));
    const turn = this.turns[this.turnIndex];
    this.turnIndex += 1;
    if (!turn) throw new Error(`ScriptedProvider exhausted (turn ${this.turnIndex})`);

    if (turn.hangUntilAbort) {
      yield { type: 'text_delta', delta: 'working...' };
      await new Promise<never>((_, reject) => {
        req.signal?.addEventListener(
          'abort',
          () => reject(req.signal!.reason ?? new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
      return; // unreachable
    }

    yield* turnEvents(turn);
  }

  get turnsConsumed(): number {
    return this.turnIndex;
  }
}

/** structuredClone chokes on AbortSignal - copy only what tests need. */
function structuredCloneish(req: CompletionRequest): CompletionRequest {
  const messages: ChatMessage[] = req.messages.map((m) => ({
    role: m.role,
    text: m.text,
    name: m.name,
    isError: m.isError,
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls?.map((c) => ({ ...c })),
  }));
  return { ...req, messages, signal: undefined } as CompletionRequest;
}
