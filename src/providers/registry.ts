import { ProviderError } from './errors.js';
import { AnthropicAdapter } from './anthropic.js';
import { DeepSeekAdapter } from './deepseek.js';
import { OpenAIAdapter } from './openai.js';
import { XaiAdapter } from './xai.js';
import type {
  CompletionRequest,
  ProviderAdapter,
  ProviderName,
  ProviderOptions,
  ResolvedProviderOptions,
} from './types.js';

export const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

/** Overridable per request; defaults are convenience only. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  xai: 'grok-3',
  deepseek: 'deepseek-chat',
};

export function resolveApiKey(name: ProviderName, opts?: ProviderOptions): string {
  const key = opts?.apiKey ?? process.env[PROVIDER_ENV_KEYS[name]];
  if (!key) {
    throw new ProviderError('fatal', `missing API key for ${name}; set ${PROVIDER_ENV_KEYS[name]} or pass apiKey`, {
      provider: name,
      providerFault: false,
    });
  }
  return key;
}

export function createProvider(name: ProviderName, opts: ProviderOptions = {}): ProviderAdapter {
  const resolved: ResolvedProviderOptions = {
    name,
    apiKey: resolveApiKey(name, opts),
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URLS[name],
    fetchImpl: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)),
    timeoutMs: opts.timeoutMs,
    retry: opts.retry,
  };
  switch (name) {
    case 'openai':
      return new OpenAIAdapter(resolved);
    case 'anthropic':
      return new AnthropicAdapter(resolved);
    case 'xai':
      return new XaiAdapter(resolved);
    case 'deepseek':
      return new DeepSeekAdapter(resolved);
  }
}

export type { CompletionRequest };
