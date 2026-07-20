export interface RateSample {
  /** Messages that reached at least "accepted" in the observation window. */
  sent: number;
  bounces: number;
  complaints: number;
}

export interface RateThresholds {
  /** Fraction of sends that may bounce before auto-pause (e.g. 0.05). */
  bounceRate: number;
  /** Fraction of sends that may draw complaints before auto-pause. */
  complaintRate: number;
  /** Minimum sample size before rates are enforced. */
  minSample: number;
}

export const DEFAULT_RATE_THRESHOLDS: RateThresholds = {
  bounceRate: 0.05,
  complaintRate: 0.001,
  minSample: 20,
};

export type RateBreach = "bounce" | "complaint" | null;

/**
 * Evaluate bounce/complaint rates against thresholds (architecture §6 step
 * 10). Below the minimum sample the rates are too noisy to act on.
 */
export function evaluateRates(
  sample: RateSample,
  thresholds: RateThresholds = DEFAULT_RATE_THRESHOLDS,
): RateBreach {
  if (sample.sent < thresholds.minSample) {
    return null;
  }
  if (sample.complaints / sample.sent >= thresholds.complaintRate) {
    return "complaint";
  }
  if (sample.bounces / sample.sent >= thresholds.bounceRate) {
    return "bounce";
  }
  return null;
}
