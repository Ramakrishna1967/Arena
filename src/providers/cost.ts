import type { ProviderName, TokenUsage } from './types.js';

/**
 * Static USD pricing per 1M tokens, keyed by exact model id first, then by
 * longest family prefix. Values drift - treat `asOf` seriously and override
 * via PRICES mutation or local config before relying on cost numbers.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  currency: 'USD';
  asOf: string;
}

export const PRICES: Record<ProviderName, Record<string, ModelPricing>> = {
  openai: {
    'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10, currency: 'USD', asOf: '2026-08-01' },
    'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6, currency: 'USD', asOf: '2026-08-01' },
    'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8, currency: 'USD', asOf: '2026-08-01' },
  },
  anthropic: {
    'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, currency: 'USD', asOf: '2026-08-01' },
    'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, currency: 'USD', asOf: '2026-08-01' },
    'claude-haiku-4': { inputPerMTok: 0.8, outputPerMTok: 4, currency: 'USD', asOf: '2026-08-01' },
  },
  xai: {
    'grok-3': { inputPerMTok: 3, outputPerMTok: 15, currency: 'USD', asOf: '2026-08-01' },
    'grok-3-mini': { inputPerMTok: 0.3, outputPerMTok: 0.5, currency: 'USD', asOf: '2026-08-01' },
  },
  deepseek: {
    'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.1, currency: 'USD', asOf: '2026-08-01' },
    'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19, currency: 'USD', asOf: '2026-08-01' },
  },
};

export function resolvePricing(provider: ProviderName, model: string): ModelPricing | undefined {
  const table = PRICES[provider];
  if (table[model]) return table[model];
  let best: { key: string; price: ModelPricing } | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price: table[key] };
    }
  }
  return best?.price;
}

export interface CostEstimate {
  amount: number;
  currency: 'USD';
}

/** Returns undefined when no pricing is known - never guesses. */
export function estimateCost(
  provider: ProviderName,
  model: string,
  usage: TokenUsage,
): CostEstimate | undefined {
  const p = resolvePricing(provider, model);
  if (!p) return undefined;
  const amount =
    (usage.inputTokens / 1_000_000) * p.inputPerMTok +
    (usage.outputTokens / 1_000_000) * p.outputPerMTok;
  return { amount: Math.round(amount * 1e6) / 1e6, currency: p.currency };
}
