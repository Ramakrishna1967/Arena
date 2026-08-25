import { ProviderError, isAbortError } from './errors.js';

export const DEFAULT_RETRY = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 8000,
} as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Retries only `ProviderError`s whose `retryable` is true (transport /
 * rate-limited). Honors server-provided retryAfterMs, else exponential
 * backoff with jitter. Aborts propagate untouched.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; signal?: AbortSignal; onRetry?: (i: { attempt: number; delayMs: number; error: ProviderError }) => void } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRY.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;

  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (isAbortError(err)) throw err;
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('fatal', `non-provider failure: ${String(err)}`, {
              provider: 'openai',
              providerFault: false,
              detail: String(err),
            });
      if (!pe.retryable || attempt >= maxRetries) throw pe;
      const raw = pe.retryAfterMs ?? Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.floor(raw * (0.85 + Math.random() * 0.3));
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: pe });
      await sleep(delayMs, opts.signal);
      attempt += 1;
    }
  }
}
