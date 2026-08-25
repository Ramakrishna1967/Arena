import { OpenAICompatibleAdapter } from './openai-compat.js';
import type { ProviderName, ResolvedProviderOptions } from './types.js';

/** xAI exposes an OpenAI-compatible chat completions API. */
export class XaiAdapter extends OpenAICompatibleAdapter {
  readonly name: ProviderName = 'xai';

  constructor(opts: ResolvedProviderOptions) {
    super(opts);
  }

  protected get endpointPath(): string {
    return '/chat/completions';
  }
}
