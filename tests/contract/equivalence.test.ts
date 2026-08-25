import { describe, expect, it } from 'vitest';
import { runScenario } from './wire-fixtures.js';

/**
 * PHASE 1 EXIT CRITERIA:
 * The same scripted multi-turn tool-calling scenario produces equivalent
 * normalized event streams across all four providers.
 */
describe('cross-provider equivalence', () => {
  it('all four providers produce equivalent normalized transcripts', async () => {
    const providers = ['openai', 'anthropic', 'xai', 'deepseek'] as const;
    const results: Record<string, Awaited<ReturnType<typeof runScenario>>> = {};
    for (const p of providers) results[p] = await runScenario(p);

    const base = results.openai;
    for (const p of providers.slice(1)) {
      const r = results[p];
      expect(r.t1.text, `${p} turn1 text`).toBe(base.t1.text);
      expect(r.t2.text, `${p} turn2 text`).toBe(base.t2.text);

      expect(r.t1.calls, `${p} turn1 calls`).toHaveLength(1);
      expect(r.t1.calls[0].name).toBe(base.t1.calls[0].name);
      expect(r.t1.calls[0].arguments).toEqual(base.t1.calls[0].arguments);

      expect(r.t1.finishes, `${p} finishes`).toEqual(base.t1.finishes);
      expect(r.t2.finishes).toEqual(base.t2.finishes);

      expect(r.t1.usages[0]?.inputTokens).toBeGreaterThan(0);
      expect(r.t1.usages[0]?.outputTokens).toBeGreaterThan(0);
    }
  });
});
