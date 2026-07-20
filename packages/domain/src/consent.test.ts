import { describe, expect, it } from "vitest";
import { decideSendability, isValidEmail, normalizeEmail } from "./consent.js";

describe("sendability", () => {
  it("allows subscribed, unsuppressed contacts", () => {
    expect(decideSendability({ membershipState: "subscribed", suppressed: false })).toEqual({
      ok: true,
    });
  });

  it("lets suppression win over an active subscription", () => {
    expect(decideSendability({ membershipState: "subscribed", suppressed: true })).toEqual({
      ok: false,
      reason: "suppressed",
    });
  });

  it("lets unsubscribe win over the snapshot", () => {
    expect(decideSendability({ membershipState: "unsubscribed", suppressed: false })).toEqual({
      ok: false,
      reason: "unsubscribed",
    });
  });

  it("blocks pending and missing memberships", () => {
    expect(decideSendability({ membershipState: "pending", suppressed: false })).toEqual({
      ok: false,
      reason: "pending",
    });
    expect(decideSendability({ membershipState: null, suppressed: false })).toEqual({
      ok: false,
      reason: "not_subscribed",
    });
  });
});

describe("email helpers", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("validates structure without overreach", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });
});
