export interface SseFrame {
  event?: string;
  data: string;
}

interface LineSplit {
  line: string;
  rest: string;
}

/** Splits off the next line handling \r\n, \n and lone \r terminators. */
function nextLine(buffer: string): LineSplit | null {
  let i = 0;
  while (i < buffer.length && buffer[i] !== '\r' && buffer[i] !== '\n') i += 1;
  if (i >= buffer.length) return null;
  const skip = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
  return { line: buffer.slice(0, i), rest: buffer.slice(i + skip) };
}

/**
 * WHATWG-flavored SSE decoder over a byte stream. Handles CRLF/LF/CR framing,
 * multi-line data, comment lines, and flushes a final unterminated line.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = function* (): Generator<SseFrame> {
    if (dataLines.length > 0 || eventName !== undefined) {
      yield { event: eventName, data: dataLines.join('\n') };
    }
    eventName = undefined;
    dataLines = [];
  };

  try {
    let active = true;
    while (active) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const split = nextLine(buffer);
        if (!split) break;
        buffer = split.rest;
        const line = split.line;
        if (line === '') {
          yield* dispatch();
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          let d = line.slice(5);
          if (d.startsWith(' ')) d = d.slice(1);
          dataLines.push(d);
        }
        // id:/retry: fields intentionally ignored
      }
    }
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) {
        let d = line.slice(5);
        if (d.startsWith(' ')) d = d.slice(1);
        dataLines.push(d);
      }
      yield* dispatch();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // stream already errored/closed
    }
  }
}
