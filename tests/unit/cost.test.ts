import { describe, expect, it } from 'vitest';
import { estimateCost, resolvePricing } from '../../src/providers/cost.js';

describe('cost accounting', () => {
  it('exact model match', () => {
    expect(resolvePricing('openai', 'gpt-4o')?.inputPerMTok).toBe(2.5);
    const c = estimateCost('openai', 'gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(c?.amount).toBe(2.5);
  });

  it('family prefix fallback for dated snapshots', () => {
    const p = resolvePricing('anthropic', 'claude-sonnet-4-20250827');
    expect(p?.inputPerMTok).toBe(3);
    expect(p?.outputPerMTok).toBe(15);
  });

  it('unknown models never guess', () => {
    expect(resolvePricing('openai', 'totally-made-up')).toBeUndefined();
    expect(estimateCost('openai', 'totally-made-up', { inputTokens: 10, outputTokens: 10 })).toBeUndefined();
  });

  it('computes blended input+output cost', () => {
    const c = estimateCost('deepseek', 'deepseek-chat', { inputTokens: 2_000_000, outputTokens: 1_000_000 });
    expect(c?.amount).toBeCloseTo(0.54 + 1.1, 6);
  });
});
