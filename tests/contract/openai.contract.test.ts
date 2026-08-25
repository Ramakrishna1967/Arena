import { describe, expect, it } from 'vitest';
import { createProvider } from '../../src/index.js';
import { collect, jsonResponse, mockFetch, sseResponse } from '../helpers.js';
import { assertScenario } from './assert-scenario.js';
import { runScenario, turn1Request, WIRE_FIXTURES, WEATHER_TOOL } from './wire-fixtures.js';

function adapter(mock: ReturnType<typeof mockFetch>, retry?: { maxRetries: number; baseDelayMs: number; maxDelayMs?: number }) {
  return createProvider('openai', { apiKey: 'test-key', fetchImpl: mock.fetch, retry });
}

describe('openai adapter contract', () => {
  it('normalizes the scripted tool scenario', async () => {
    const { t1, t2, mock } = await runScenario('openai');
    assertScenario(t1, t2);

    // Wire shape: endpoint, auth header, stream usage opt-in, tool mapping.
    expect(mock.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    const init = mock.calls[0].init!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools[0].function.name).toBe(WEATHER_TOOL.name);
  });

  it('non-streaming path yields identical normalized events', async () => {
    const full = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Hi there',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    };
    const mock = mockFetch([() => jsonResponse(full)]);
    const got = await collect(
      adapter(mock).complete({
        ...turn1Request(),
        messages: [{ role: 'user', text: 'hi' }],
        stream: false,
      }),
    );
    expect(got.text).toBe('Hi there');
    expect(got.calls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(got.finishes).toEqual(['stop']);
    expect(got.usages[0]).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('retries 429 then succeeds', async () => {
    const mock = mockFetch([
      () => jsonResponse({ error: { message: 'Too many requests' } }, 429),
      () => sseResponse(WIRE_FIXTURES.openai.turn1),
    ]);
    const got = await collect(adapter(mock, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }).complete(turn1Request()));
    expect(got.finishes).toEqual(['tool_calls']);
    expect(mock.calls).toHaveLength(2);
  });

  it('exhausts retries on 500 and throws transport_retryable tagged providerFault', async () => {
    const mock = mockFetch([
      () => jsonResponse({ error: { message: 'upstream' } }, 500),
      () => jsonResponse({ error: { message: 'upstream' } }, 500),
      () => jsonResponse({ error: { message: 'upstream' } }, 500),
    ]);
    await expect(
      collect(adapter(mock, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }).complete(turn1Request())),
    ).rejects.toMatchObject({
      kind: 'transport_retryable',
      providerFault: true,
      status: 500,
    });
    expect(mock.calls).toHaveLength(3);
  });

  it('classifies schema-rejecting 400 as schema_violation without retrying', async () => {
    const mock = mockFetch([
      () => jsonResponse({ error: { message: "tools.0.function.parameters: missing 'properties'" } }, 400),
    ]);
    await expect(
      collect(adapter(mock, { maxRetries: 3, baseDelayMs: 1 }).complete(turn1Request())),
    ).rejects.toMatchObject({ kind: 'schema_violation', providerFault: true });
    expect(mock.calls).toHaveLength(1);
  });

  it('surfaces 200-with-error-envelope as schema_violation when tools-related', async () => {
    const mock = mockFetch([
      () => jsonResponse({ error: { type: 'invalid_request_error', message: "bad 'tools' payload" } }),
    ]);
    await expect(
      collect(adapter(mock).complete({ ...turn1Request(), stream: false })),
    ).rejects.toMatchObject({ kind: 'schema_violation', providerFault: true });
  });

  it('throws malformed (provider-fault) on unparseable tool arguments', async () => {
    const bad = [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"get_weather","arguments":"{not json"}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const mock = mockFetch([() => sseResponse(bad)]);
    await expect(collect(adapter(mock).complete(turn1Request()))).rejects.toMatchObject({
      kind: 'schema_violation',
      providerFault: true,
      name: 'ProviderError',
    });
  });
});
