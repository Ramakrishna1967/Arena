import { describe, expect, it } from 'vitest';
import { toAnthropicRequest } from '../../src/providers/anthropic.js';
import type { ChatMessage } from '../../src/providers/types.js';

const TOOL = { name: 'get_weather', parameters: { type: 'object' } };

function msgs(list: ChatMessage[]): Record<string, unknown> {
  return toAnthropicRequest({
    model: 'm',
    messages: list,
    tools: [TOOL],
  });
}

describe('anthropic message mapping', () => {
  it('extracts system prompts to the top-level param', () => {
    const body = msgs([
      { role: 'system', text: 'S1' },
      { role: 'user', text: 'u1' },
    ]);
    expect(body.system).toBe('S1');
  });

  it('merges consecutive same-role messages (strict alternation)', () => {
    const call = { id: 'c1', name: 'get_weather', arguments: { city: 'Oslo' } };
    const body = msgs([
      { role: 'system', text: 'S1' },
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'thinking...', toolCalls: [call] },
      { role: 'tool', toolCallId: 'c1', text: 'cold' },
      { role: 'tool', toolCallId: 'c2', text: 'also cold', isError: true },
    ]);
    expect(body.system).toBe('S1');
    const m = body.messages as any[];
    expect(m).toHaveLength(3);
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    // assistant carries text + tool_use blocks
    const kinds = m[1].content.map((b: any) => b.type);
    expect(kinds).toEqual(['text', 'tool_use']);
    expect(m[1].content[1]).toMatchObject({ id: 'c1', name: 'get_weather', input: { city: 'Oslo' } });
    // consecutive tool results merge into one user turn
    expect(m[2].content).toHaveLength(2);
    expect(m[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'cold' });
    expect(m[2].content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'c2', is_error: true });
  });

  it('prepends a synthetic user marker when history opens with assistant', () => {
    const body = msgs([{ role: 'assistant', text: 'resumed context' }]);
    const m = body.messages as any[];
    expect(m[0].role).toBe('user');
    expect(m[0].content[0].type).toBe('text');
  });

  it('degenerate empty history falls back to system-as-user', () => {
    const body = toAnthropicRequest({ model: 'm', messages: [], system: 'only sys' });
    const m = body.messages as any[];
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe('user');
    expect(m[0].content[0].text).toBe('only sys');
  });

  it('maps tools to input_schema and defaults stream/max_tokens', () => {
    const body = msgs([{ role: 'user', text: 'hi' }]);
    expect((body.tools as any[])[0]).toEqual({
      name: 'get_weather',
      description: '',
      input_schema: { type: 'object' },
    });
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
  });
});
