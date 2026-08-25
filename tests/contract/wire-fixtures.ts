import type { CompletionRequest, ProviderName } from '../../src/index.js';
import { createProvider } from '../../src/index.js';
import { collect, mockFetch, sseResponse, type CollectedStream, type MockFetch } from '../helpers.js';

export const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
} as const;

export const T1_TEXT = 'Checking weather';
export const T2_TEXT = 'It is 22 degrees.';
export const WEATHER_ARGS = { city: 'Tokyo' };

/**
 * Canned wire traffic for one scripted scenario, per provider dialect:
 * turn 1 -> text + tool_call(get_weather, {city:Tokyo}) + finish(tool_calls)
 * turn 2 -> text + finish(stop)
 */
export const WIRE_FIXTURES: Record<ProviderName, { turn1: string[]; turn2: string[] }> = {
  openai: {
    turn1: [
      `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"${T1_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_oa_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Tokyo\\"}"}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":30}}\n\n`,
      `data: [DONE]\n\n`,
    ],
    turn2: [
      `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"${T2_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":8}}\n\n`,
      `data: [DONE]\n\n`,
    ],
  },
  xai: {
    // Same dialect as OpenAI; distinct call-id shape proves ids flow through.
    turn1: [
      `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"${T1_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xai_9f2","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":27}}\n\n`,
      `data: [DONE]\n\n`,
    ],
    turn2: [
      `data: {"choices":[{"index":0,"delta":{"content":"${T2_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":44,"completion_tokens":6}}\n\n`,
      `data: [DONE]\n\n`,
    ],
  },
  deepseek: {
    // Variant dialect: tool name arrives in a LATER fragment than the id,
    // exercising deferred tool_call_start emission.
    turn1: [
      `data: {"choices":[{"index":0,"delta":{"content":"${T1_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ds_1","type":"function","function":{"arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Tokyo\\"}"}}]}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: {"usage":{"prompt_tokens":10,"completion_tokens":25}}\n\n`,
      `data: [DONE]\n\n`,
    ],
    turn2: [
      `data: {"choices":[{"index":0,"delta":{"content":"${T2_TEXT}"}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":38,"completion_tokens":9}}\n\n`,
      `data: [DONE]\n\n`,
    ],
  },
  anthropic: {
    turn1: [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n`,
      `event: ping\ndata: {"type":"ping"}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${T1_TEXT}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather","input":{}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Tokyo\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":33}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ],
    turn2: [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":52,"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${T2_TEXT}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ],
  },
};

export function turn1Request(model = 'test-model'): CompletionRequest {
  return {
    model,
    messages: [{ role: 'user', text: 'What is the weather in Tokyo?' }],
    tools: [WEATHER_TOOL],
  };
}

export function turn2Request(prev: CollectedStream, model = 'test-model'): CompletionRequest {
  const call = prev.calls[0];
  return {
    model,
    messages: [
      { role: 'user', text: 'What is the weather in Tokyo?' },
      { role: 'assistant', text: prev.text, toolCalls: prev.calls },
      { role: 'tool', toolCallId: call.id, name: call.name, text: '22C, sunny' },
    ],
    tools: [WEATHER_TOOL],
  };
}

/** Runs the scripted two-turn scenario against a provider's canned traffic. */
export async function runScenario(
  provider: ProviderName,
  opts: { retryMax?: number; baseDelayMs?: number } = {},
): Promise<{ t1: CollectedStream; t2: CollectedStream; mock: MockFetch }> {
  const fx = WIRE_FIXTURES[provider];
  const mock = mockFetch([
    () => sseResponse(fx.turn1),
    () => sseResponse(fx.turn2),
  ]);
  const adapter = createProvider(provider, {
    apiKey: 'test-key',
    fetchImpl: mock.fetch,
    retry: { maxRetries: opts.retryMax ?? 1, baseDelayMs: opts.baseDelayMs ?? 1, maxDelayMs: 5 },
  });

  const t1 = await collect(adapter.complete(turn1Request()));
  const t2 = await collect(adapter.complete(turn2Request(t1)));
  return { t1, t2, mock };
}
