import { describe, expect, it } from 'vitest';
import { createProvider } from '../../src/index.js';
import type { CompletionRequest } from '../../src/index.js';
import { collect, jsonResponse, mockFetch, sseResponse } from '../helpers.js';
import { assertScenario } from './assert-scenario.js';
import { runScenario, turn1Request, turn2Request, WIRE_FIXTURES } from './wire-fixtures.js';

function adapter(mock: ReturnType<typeof mockFetch>, retry?: { maxRetries: number; baseDelayMs: number }) {
  return createProvider('anthropic', { apiKey: 'test-key', fetchImpl: mock.fetch, retry });
}

describe('anthropic adapter contract', () => {
  it('normalizes the scripted tool scenario', async () => {
    const { t1, t2, mock } = await runScenario('anthropic');
    assertScenario(t1, t2);

    // Wire shape: /v1/messages endpoint + required version header.
    expect(mock.calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = mock.calls[0].init!.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe('test-key');

    // Second request must map the normalized history to Messages dialect:
    // [user, assistant(tool_use), user(tool_result)] and NO system key.
    const body2 = JSON.parse(String(mock.calls[1].init!.body));
    expect('system' in body2).toBe(false);
    expect(body2.messages).toHaveLength(3);
    expect(body2.messages[1].role).toBe('assistant');
    expect(body2.messages[1].content.some((b: any) => b.type === 'tool_use' && b.id === 'toolu_abc')).toBe(true);
    const lastBlock = body2.messages[2].content[0];
    expect(lastBlock.type).toBe('tool_result');
    expect(lastBlock.tool_use_id).toBe('toolu_abc');
    expect(lastBlock.content).toBe('22C, sunny');
  });

  it('moves system prompt to top-level param', async () => {
    const mock = mockFetch([() => sseResponse(WIRE_FIXTURES.anthropic.turn1)]);
    const req: CompletionRequest = { ...turn1Request(), system: 'You are terse.' };
    await collect(adapter(mock).complete(req));
    const body = JSON.parse(String(mock.calls[0].init!.body));
    expect(body.system).toBe('You are terse.');
    expect(body.max_tokens).toBe(1024); // Anthropic requires max_tokens
    expect(body.tools[0].input_schema).toBeDefined();
  });

  it('retries 429 then succeeds', async () => {
    const mock = mockFetch([
      () => jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429),
      () => sseResponse(WIRE_FIXTURES.anthropic.turn1),
    ]);
    const got = await collect(adapter(mock, { maxRetries: 2, baseDelayMs: 1 }).complete(turn1Request()));
    expect(got.finishes).toEqual(['tool_calls']);
    expect(mock.calls).toHaveLength(2);
  });

  it('exhausts retries on overloaded/5xx as transport_retryable providerFault', async () => {
    const mock = mockFetch([
      () => new Response('overloaded', { status: 529 }),
      () => new Response('overloaded', { status: 529 }),
      () => new Response('overloaded', { status: 529 }),
    ]);
    await expect(
      collect(adapter(mock, { maxRetries: 2, baseDelayMs: 1 }).complete(turn1Request())),
    ).rejects.toMatchObject({ kind: 'transport_retryable', providerFault: true });
    expect(mock.calls).toHaveLength(3);
  });

  it('mid-stream overloaded_error event throws retryable provider-fault error', async () => {
    const frames = [
      ...WIRE_FIXTURES.anthropic.turn1.slice(0, 4),
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
    ];
    const mock = mockFetch([() => sseResponse(frames)]);
    await expect(collect(adapter(mock).complete(turn1Request()))).rejects.toMatchObject({
      kind: 'transport_retryable',
      providerFault: true,
    });
  });

  it('maps invalid_request_error envelope without schema markers to fatal caller fault', async () => {
    const mock = mockFetch([
      () =>
        jsonResponse({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'max_tokens: field required' },
        }),
    ]);
    await expect(
      collect(adapter(mock).complete({ ...turn1Request(), stream: false })),
    ).rejects.toMatchObject({ kind: 'fatal', providerFault: false });
    expect(mock.calls).toHaveLength(1);
  });

  it('full two-turn flow keeps tool ids stable for tool_result correlation', async () => {
    const { t1, mock } = await runScenario('anthropic');
    void mock;
    expect(t1.calls[0].id).toBe('toolu_abc');
    // turn2 request built by fixtures uses that id; sanity-check mapping again.
    const req = turn2Request(t1);
    expect(req.messages[2].toolCallId).toBe('toolu_abc');
  });
});
