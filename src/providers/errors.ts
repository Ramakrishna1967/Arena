import type { ProviderName } from './types.js';

/**
 * Fault taxonomy (architecture L1 contract):
 * - transport_retryable : network/5xx/overloaded - safe to retry with backoff
 * - rate_limited        : 429 - retry honoring Retry-After
 * - schema_violation    : request/response failed schema expectations.
 *                         Often a CANONICALIZER bug (our mapping), so it is
 *                         tagged providerFault=true when triggered by tool
 *                         schema wording, letting the Arbiter exclude it.
 * - fatal               : auth, not found, bad caller params - do not retry
 *
 * `providerFault` = infrastructure/model-output side (Arbiter may exclude
 * from agent scoring). false = caller-side config/request problem.
 */
export type FaultKind =
  | 'transport_retryable'
  | 'rate_limited'
  | 'schema_violation'
  | 'fatal';

const SCHEMA_MARKERS =
  /(schema|tools?\b|function|json|parameter|input|properties|strict)/i;

export class ProviderError extends Error {
  readonly kind: FaultKind;
  readonly provider: ProviderName;
  readonly status?: number;
  readonly providerFault: boolean;
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(
    kind: FaultKind,
    message: string,
    opts: {
      provider: ProviderName;
      status?: number;
      providerFault?: boolean;
      retryAfterMs?: number;
      detail?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.providerFault = opts.providerFault ?? kind === 'transport_retryable';
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  get retryable(): boolean {
    return this.kind === 'transport_retryable' || this.kind === 'rate_limited';
  }

  static fromHttpStatus(
    provider: ProviderName,
    status: number,
    bodyText: string,
    retryAfterHeader?: string | null,
  ): ProviderError {
    const snippet = bodyText.slice(0, 500);
    const base = { provider, status, detail: snippet };

    if (status === 429) {
      return new ProviderError('rate_limited', `rate limited (429): ${snippet}`, {
        ...base,
        retryAfterMs: parseRetryAfter(retryAfterHeader),
      });
    }
    if (status === 408 || status === 529 || status >= 500) {
      return new ProviderError('transport_retryable', `upstream failure (${status}): ${snippet}`, base);
    }
    if (status === 400 || status === 422) {
      if (SCHEMA_MARKERS.test(snippet)) {
        // Likely OUR canonicalizer produced something the API rejects.
        return new ProviderError('schema_violation', `request rejected as schema problem (${status}): ${snippet}`, {
          ...base,
          providerFault: true,
        });
      }
      return new ProviderError('fatal', `bad request (${status}): ${snippet}`, {
        ...base,
        providerFault: false,
      });
    }
    return new ProviderError('fatal', `request failed (${status}): ${snippet}`, {
      ...base,
      providerFault: false,
    });
  }

  static network(provider: ProviderName, err: unknown): ProviderError {
    if (isTimeoutError(err)) {
      return new ProviderError('transport_retryable', 'provider timed out', {
        provider,
        detail: String(err),
      });
    }
    return new ProviderError('transport_retryable', `network failure: ${String(err)}`, {
      provider,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  /** Response/stream content we could not normalize (bad JSON, bad args). */
  static malformed(provider: ProviderName, what: string, detail?: unknown): ProviderError {
    return new ProviderError('schema_violation', `unnormalizable ${what} from ${provider}`, {
      provider,
      providerFault: true,
      detail,
    });
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** Parses Retry-After: seconds ("2") or HTTP-date. Returns ms or undefined. */
export function parseRetryAfter(header?: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
