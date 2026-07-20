import { describe, expect, it } from "vitest";
import { evaluateRates } from "./thresholds.js";

const thresholds = { bounceRate: 0.05, complaintRate: 0.01, minSample: 10 };

describe("bounce/complaint thresholds", () => {
  it("ignores small samples", () => {
    expect(evaluateRates({ sent: 5, bounces: 5, complaints: 5 }, thresholds)).toBeNull();
  });

  it("breaches on complaints first, then bounces", () => {
    expect(evaluateRates({ sent: 100, bounces: 10, complaints: 2 }, thresholds)).toBe("complaint");
    expect(evaluateRates({ sent: 100, bounces: 10, complaints: 0 }, thresholds)).toBe("bounce");
  });

  it("passes healthy traffic", () => {
    expect(evaluateRates({ sent: 1000, bounces: 10, complaints: 0 }, thresholds)).toBeNull();
  });
});
