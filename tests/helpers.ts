import type {
  FinishReason,
  NormalizedToolCall,
  StreamEvent,
  TokenUsage,
} from '../src/providers/types.js';

const encoder = new TextEncoder();

/** Builds a 200 SSE Response whose body streams `chunks` sequentially. */
export function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

export interface MockFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

/** Sequential canned-response fetch. Records every call for wire assertions. */
export function mockFetch(responses: Array<Response | (() => Response)>): MockFetch {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (i >= responses.length) throw new Error(`unexpected fetch #${i + 1}`);
    const r = responses[i];
    i += 1;
    return typeof r === 'function' ? r() : r;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export interface CollectedStream {
  events: StreamEvent[];
  text: string;
  calls: NormalizedToolCall[];
  finishes: FinishReason[];
  usages: Array<TokenUsage | undefined>;
}

export async function collect(gen: AsyncIterable<StreamEvent>): Promise<CollectedStream> {
  const out: CollectedStream = { events: [], text: '', calls: [], finishes: [], usages: [] };
  for await (const e of gen) {
    out.events.push(e);
    if (e.type === 'text_delta') out.text += e.delta;
    else if (e.type === 'tool_call_end') out.calls.push(e.call);
    else if (e.type === 'finish') {
      out.finishes.push(e.reason);
      out.usages.push(e.usage);
    }
  }
  return out;
}
