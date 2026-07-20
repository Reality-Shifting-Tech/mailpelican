import { describe, expect, it } from "vitest";
import { generateToken, hashToken, isExpired, verifyToken } from "./tokens.js";

describe("tokens", () => {
  it("generates 256-bit tokens whose hash verifies", () => {
    const { raw, hash } = generateToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyToken(raw, hash)).toBe(true);
  });

  it("never stores a reversible form", () => {
    const { raw, hash } = generateToken();
    expect(hash).not.toContain(raw);
    expect(hashToken(raw)).toBe(hash);
  });

  it("rejects wrong and malformed tokens in constant time shape", () => {
    const { raw, hash } = generateToken();
    expect(verifyToken(`${raw}x`, hash)).toBe(false);
    expect(verifyToken("short", hash)).toBe(false);
    expect(verifyToken(raw, "deadbeef")).toBe(false);
  });

  it("compares expiry against a clock", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    expect(isExpired(new Date("2025-05-31T23:59:59Z"), now)).toBe(true);
    expect(isExpired(new Date("2025-06-01T00:00:01Z"), now)).toBe(false);
  });
});
