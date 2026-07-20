/**
 * Pure token-bucket arithmetic for relay rate limiting. The state is stored
 * externally (Redis in production, memory in tests); this module only decides
 * whether a token is available and what the next state is.
 */
export interface TokenBucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface TokenBucketConfig {
  /** Sustained refill rate in tokens per second. */
  ratePerSecond: number;
  /** Maximum accumulated tokens; also the initial bucket size. */
  burst: number;
}

export function initialBucket(config: TokenBucketConfig): TokenBucketState {
  return { tokens: config.burst, updatedAtMs: 0 };
}

/**
 * Attempt to take one token at `nowMs`. The bucket refills continuously at
 * the configured rate and never exceeds the burst ceiling.
 */
export function takeToken(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
): { state: TokenBucketState; allowed: boolean } {
  const elapsedMs = Math.max(0, nowMs - state.updatedAtMs);
  const refilled = Math.min(config.burst, state.tokens + (elapsedMs / 1000) * config.ratePerSecond);
  if (refilled < 1) {
    return { state: { tokens: refilled, updatedAtMs: nowMs }, allowed: false };
  }
  return { state: { tokens: refilled - 1, updatedAtMs: nowMs }, allowed: true };
}

/** Milliseconds until at least one token is available, 0 when already full. */
export function retryAfterMs(state: TokenBucketState, config: TokenBucketConfig): number {
  if (state.tokens >= 1) {
    return 0;
  }
  return Math.ceil(((1 - state.tokens) / config.ratePerSecond) * 1000);
}
