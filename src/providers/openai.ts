import { OpenAICompatibleAdapter } from './openai-compat.js';
import type { CompletionRequest, ProviderName, ResolvedProviderOptions } from './types.js';

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  readonly name: ProviderName = 'openai';

  constructor(opts: ResolvedProviderOptions) {
    super(opts);
  }

  protected get endpointPath(): string {
    return '/chat/completions';
  }

  protected override amendBody(_req: CompletionRequest, body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }
}
