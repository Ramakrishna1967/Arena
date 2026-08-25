import { ProviderError, isAbortError } from './errors.js';
import { withRetry, DEFAULT_RETRY } from './retry.js';
import type { RetryOptions } from './types.js';

export interface SendParams {
  provider: Parameters<typeof ProviderError.fromHttpStatus>[0];
  url: string;
  headers: Record<string, string>;
  bodyJson: unknown;
  apiKey: string;
  fetchImpl: typeof fetch;
  retry?: RetryOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const parts = [signal, timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * POSTs and resolves once response HEADERS are OK. All transport-level
 * retries happen here. Deliberate boundary (documented in architecture):
 * mid-stream failures after headers are NOT auto-retried - retrying would
 * replay already-emitted deltas. The Agent Core decides whether to resume.
 */
export async function postForResponse(p: SendParams): Promise<Response> {
  const signal = combineSignals(p.signal, p.timeoutMs);
  return withRetry(
    async () => {
      let res: Response;
      try {
        res = await p.fetchImpl(p.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...p.headers },
          body: JSON.stringify(p.bodyJson),
          signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw ProviderError.network(p.provider, err);
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw ProviderError.fromHttpStatus(
          p.provider,
          res.status,
          text,
          res.headers.get('retry-after'),
        );
      }
      return res;
    },
    {
      maxRetries: p.retry?.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseDelayMs: p.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: p.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
      signal: p.signal,
      onRetry: p.retry?.onRetry,
    },
  );
}
