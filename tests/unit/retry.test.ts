import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/providers/errors.js';
import { withRetry } from '../../src/providers/retry.js';

afterEach(() => vi.useRealTimers());

describe('withRetry', () => {
  it('retries transport_retryable until success', async () => {
    let n = 0;
    const res = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw new ProviderError('transport_retryable', 'flaky', { provider: 'openai' });
        return 'ok';
      },
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry fatal errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new ProviderError('fatal', 'nope', { provider: 'openai', providerFault: false });
        },
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'fatal' });
    expect(n).toBe(1);
  });

  it('does not retry schema_violation (canonicalizer bugs are not transient)', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new ProviderError('schema_violation', 'bad args', { provider: 'xai', providerFault: true });
        },
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'schema_violation' });
    expect(n).toBe(1);
  });

  it('honors server retryAfterMs over computed backoff and reports via onRetry', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    let n = 0;
    const p = withRetry(
      async () => {
        if (n++ === 0) {
          throw new ProviderError('rate_limited', 'rl', { provider: 'deepseek', retryAfterMs: 1000 });
        }
        return 'ok';
      },
      { onRetry: (i) => delays.push(i.delayMs) },
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toBe('ok');
    expect(delays[0]).toBeGreaterThanOrEqual(850);
    expect(delays[0]).toBeLessThanOrEqual(1150); // jitter band around 1000ms
  });

  it('propagates aborts untouched without retrying', async () => {
    const abortErr = new DOMException('cancelled', 'AbortError');
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw abortErr;
        },
        { maxRetries: 3 },
      ),
    ).rejects.toBe(abortErr);
    expect(n).toBe(1);
  });
});
