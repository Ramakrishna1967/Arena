import { describe, expect, it } from 'vitest';
import { assertScenario } from './assert-scenario.js';
import { runScenario } from './wire-fixtures.js';

describe('xai adapter contract', () => {
  it('normalizes the scripted tool scenario over the OpenAI-compatible API', async () => {
    const { t1, t2, mock } = await runScenario('xai');
    assertScenario(t1, t2);

    expect(mock.calls[0].url).toBe('https://api.x.ai/v1/chat/completions');
    expect((mock.calls[0].init!.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    // Distinct id shape proves provider call-ids pass through untouched.
    expect(t1.calls[0].id).toBe('call_xai_9f2');
  });
});
