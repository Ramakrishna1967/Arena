import { describe, expect, it } from 'vitest';
import { parseRetryAfter, ProviderError } from '../../src/providers/errors.js';

describe('error taxonomy classification', () => {
  it('5xx/408/529 -> transport_retryable, provider-fault', () => {
    for (const status of [500, 502, 503, 529, 408]) {
      const e = ProviderError.fromHttpStatus('openai', status, 'oops');
      expect(e.kind).toBe('transport_retryable');
      expect(e.providerFault).toBe(true);
      expect(e.retryable).toBe(true);
    }
  });

  it('429 -> rate_limited with parsed Retry-After', () => {
    const e = ProviderError.fromHttpStatus('anthropic', 429, 'slow', '2');
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(2000);
    expect(e.retryable).toBe(true);
  });

  it('400 mentioning tools/schema -> schema_violation tagged providerFault (canonicalizer suspicion)', () => {
    const e = ProviderError.fromHttpStatus('xai', 400, "tools.0: invalid JSON schema for 'parameters'");
    expect(e.kind).toBe('schema_violation');
    expect(e.providerFault).toBe(true);
    expect(e.retryable).toBe(false);
  });

  it('400 without schema markers -> fatal caller fault', () => {
    const e = ProviderError.fromHttpStatus('deepseek', 400, 'max_tokens must be positive');
    expect(e.kind).toBe('fatal');
    expect(e.providerFault).toBe(false);
    expect(e.retryable).toBe(false);
  });

  it('401/403/404 -> fatal caller fault', () => {
    for (const status of [401, 403, 404]) {
      const e = ProviderError.fromHttpStatus('openai', status, 'denied');
      expect(e.kind).toBe('fatal');
      expect(e.providerFault).toBe(false);
    }
  });

  it('parseRetryAfter handles seconds and HTTP-dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future)!;
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});
