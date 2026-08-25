import { OpenAICompatibleAdapter } from './openai-compat.js';
import type { CompletionRequest, ProviderName, ResolvedProviderOptions } from './types.js';

/**
 * DeepSeek exposes an OpenAI-compatible API at /v1.
 * Note: deepseek-reasoner historically rejects tools - that surfaces as a
 * schema_violation tagged providerFault=true, which the Arbiter can exclude.
 */
export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  readonly name: ProviderName = 'deepseek';

  constructor(opts: ResolvedProviderOptions) {
    super(opts);
  }

  protected get endpointPath(): string {
    return '/chat/completions';
  }

  protected override amendBody(req: CompletionRequest, body: Record<string, unknown>): Record<string, unknown> {
    // deepseek-reasoner ignores temperature/tool_choice knobs; drop them to
    // avoid 400s rather than shipping known-rejected params.
    if (String(body.model).startsWith('deepseek-reasoner')) {
      delete body.temperature;
    }
    void req;
    return body;
  }
}
