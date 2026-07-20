import { describe, expect, it } from "vitest";
import { initialBucket, retryAfterMs, takeToken } from "./rate-limit.js";

const config = { ratePerSecond: 2, burst: 3 };

describe("token bucket", () => {
  it("allows up to the burst then blocks", () => {
    let state = initialBucket(config);
    for (let i = 0; i < 3; i += 1) {
      const result = takeToken(state, config, 1000);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    expect(takeToken(state, config, 1000).allowed).toBe(false);
  });

  it("refills at the configured rate", () => {
    let state = initialBucket(config);
    state = takeToken(state, config, 0).state;
    state = takeToken(state, config, 0).state;
    state = takeToken(state, config, 0).state;
    const denied = takeToken(state, config, 0);
    expect(denied.allowed).toBe(false);
    const afterHalfSecond = takeToken(denied.state, config, 500);
    expect(afterHalfSecond.allowed).toBe(true);
  });

  it("never exceeds the burst ceiling", () => {
    const state = takeToken(initialBucket(config), config, 60_000).state;
    expect(state.tokens).toBeLessThanOrEqual(config.burst);
  });

  it("reports time until the next token", () => {
    const empty = { tokens: 0, updatedAtMs: 0 };
    expect(retryAfterMs(empty, config)).toBe(500);
    expect(retryAfterMs({ tokens: 2, updatedAtMs: 0 }, config)).toBe(0);
  });
});
