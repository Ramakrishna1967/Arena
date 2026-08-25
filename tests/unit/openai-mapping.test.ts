import { describe, expect, it } from 'vitest';
import { mapMessagesToOpenAI } from '../../src/providers/openai-compat.js';

describe('openai message mapping', () => {
  it('emits top-level system first, then maps all roles', () => {
    const out = mapMessagesToOpenAI({
      model: 'm',
      system: 'SYS',
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'a', toolCalls: [{ id: 'c1', name: 'f', arguments: { x: 1 } }] },
        { role: 'tool', toolCallId: 'c1', name: 'f', text: 'result' },
      ],
      tools: [{ name: 'f', parameters: {} }],
    }) as any[];

    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'q' });
    expect(out[2].tool_calls[0].function).toEqual({ name: 'f', arguments: '{"x":1}' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', name: 'f', content: 'result' });
  });

  it('assistant without tool calls serializes null content cleanly', () => {
    const out = mapMessagesToOpenAI({ model: 'm', messages: [{ role: 'assistant', toolCalls: [] }] }) as any[];
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls).toBeUndefined();
  });
});
