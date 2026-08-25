import { describe, expect, it } from 'vitest';
import { assertScenario } from './assert-scenario.js';
import { runScenario } from './wire-fixtures.js';

describe('deepseek adapter contract', () => {
  it('normalizes the scripted tool scenario even when name lags id across fragments', async () => {
    const { t1, t2, mock } = await runScenario('deepseek');
    assertScenario(t1, t2);

    expect(mock.calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    // The fixture splits id/name into separate fragments; deferred start must
    // still yield exactly one start/end pair with buffered args intact.
    expect(t1.events.filter((e) => e.type === 'tool_call_start')).toHaveLength(1);
    expect(t1.calls[0].id).toBe('call_ds_1');
  });
});
