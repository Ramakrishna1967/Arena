import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../../src/providers/sse.js';

const enc = new TextEncoder();
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const f of parseSseStream(s)) out.push(f);
  return out;
}

describe('sse parser', () => {
  it('joins multi-line data fields into one frame', async () => {
    const frames = await drain(streamOf(['data: hello\ndata: world\n\n']));
    expect(frames).toEqual([{ data: 'hello\nworld' }]);
  });

  it('handles CRLF framing', async () => {
    const frames = await drain(streamOf(['data: a\r\ndata: b\r\n\r\n']));
    expect(frames).toEqual([{ data: 'a\nb' }]);
  });

  it('handles lone CR framing (degenerate servers)', async () => {
    const frames = await drain(streamOf(['data: a\rdata: b\r\r']));
    expect(frames).toEqual([{ data: 'a\nb' }]);
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const frames = await drain(streamOf(['data: he', 'llo', ' wo', 'rld\n', '\n']));
    expect(frames).toEqual([{ data: 'hello world' }]);
  });

  it('ignores comments and captures event names', async () => {
    const frames = await drain(streamOf([': ping\nevent: foo\ndata: 1\n\n']));
    expect(frames).toEqual([{ event: 'foo', data: '1' }]);
  });

  it('flushes a final unterminated line at EOF', async () => {
    const frames = await drain(streamOf(['data: tail']));
    expect(frames).toEqual([{ data: 'tail' }]);
  });

  it('strips exactly one leading space after the colon', async () => {
    const frames = await drain(streamOf(['data:  two-space\n\n']));
    expect(frames).toEqual([{ data: ' two-space' }]);
  });

  it('suppresses empty frames with no data', async () => {
    const frames = await drain(streamOf(['\n\n\n']));
    expect(frames).toEqual([]);
  });
});
