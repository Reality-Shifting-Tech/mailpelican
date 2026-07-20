import { describe, expect, it } from "vitest";
import { backoffDelayMs, canRetry, classifySendError } from "./retry.js";

describe("retry classification", () => {
  it("treats 5xx and 429 as retryable", () => {
    expect(classifySendError({ status: 500 })).toBe("retryable");
    expect(classifySendError({ status: 429 })).toBe("retryable");
  });

  it("treats 4xx rejections as terminal", () => {
    expect(classifySendError({ status: 400 })).toBe("terminal");
    expect(classifySendError({ status: 403 })).toBe("terminal");
  });

  it("classifies provider error codes", () => {
    expect(classifySendError({ code: "MessageRejected" })).toBe("terminal");
    expect(classifySendError({ code: "Throttling" })).toBe("retryable");
    expect(classifySendError({ code: "ETIMEDOUT" })).toBe("retryable");
  });

  it("defaults unknown errors to retryable so nothing is silently dropped", () => {
    expect(classifySendError({})).toBe("retryable");
  });
});

describe("backoff", () => {
  it("grows exponentially from the base delay", () => {
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 60_000)).toBe(4000);
  });

  it("caps at the maximum delay", () => {
    expect(backoffDelayMs(20, 1000, 60_000)).toBe(60_000);
  });

  it("bounds total attempts", () => {
    expect(canRetry(7, 8)).toBe(true);
    expect(canRetry(8, 8)).toBe(false);
  });
});
