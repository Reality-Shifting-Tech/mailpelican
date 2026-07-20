export type RetryClass = "retryable" | "terminal";

export interface SendErrorShape {
  /** HTTP-style status from the provider, when available. */
  status?: number;
  /** Provider or transport error code (e.g. "ETIMEDOUT", "MessageRejected"). */
  code?: string;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "Throttling",
  "ThrottlingException",
  "ServiceUnavailable",
  "InternalFailure",
  "RequestTimeout",
]);

const TERMINAL_CODES: ReadonlySet<string> = new Set([
  "MessageRejected",
  "InvalidParameterValue",
  "MailFromDomainNotVerified",
  "ConfigurationSetDoesNotExist",
]);

/**
 * Classify a provider or transport failure. 5xx and throttling statuses and
 * network-level codes are retryable; 4xx validation/rejection failures are
 * terminal. Unknown errors default to retryable so a transient fault never
 * silently drops a message, and the attempt bound still guarantees an end.
 */
export function classifySendError(error: SendErrorShape): RetryClass {
  if (error.code !== undefined) {
    if (TERMINAL_CODES.has(error.code)) {
      return "terminal";
    }
    if (RETRYABLE_CODES.has(error.code)) {
      return "retryable";
    }
  }
  if (error.status !== undefined) {
    if (error.status === 429 || error.status >= 500) {
      return "retryable";
    }
    if (error.status >= 400 && error.status < 500) {
      return "terminal";
    }
  }
  return "retryable";
}

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 30 * 60_000;
export const RETRY_MAX_ATTEMPTS = 8;

/**
 * Bounded exponential backoff: base * 2^(attempt-1), capped. Deterministic;
 * callers add jitter if needed. Attempts beyond the cap stay at the ceiling
 * so the retry budget is predictable.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number = RETRY_BASE_DELAY_MS,
  maxMs: number = RETRY_MAX_DELAY_MS,
): number {
  if (attempt < 1) {
    return baseMs;
  }
  const delay = baseMs * 2 ** (attempt - 1);
  return Math.min(delay, maxMs);
}

/** True while another delivery attempt is allowed. */
export function canRetry(attempts: number, maxAttempts: number = RETRY_MAX_ATTEMPTS): boolean {
  return attempts < maxAttempts;
}
