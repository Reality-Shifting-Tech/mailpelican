import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface GeneratedToken {
  /** Raw token returned to the caller exactly once; never stored. */
  raw: string;
  /** SHA-256 hex digest of the raw token; the only persisted form. */
  hash: string;
}

/**
 * Generate a random 256-bit token. The raw value is base64url-encoded; only
 * its SHA-256 hash may be persisted (architecture §10).
 */
export function generateToken(): GeneratedToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** Hash a raw token for storage or lookup. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented raw token against a stored hash.
 * Returns false for malformed input instead of throwing.
 */
export function verifyToken(raw: string, storedHash: string): boolean {
  const presented = hashToken(raw);
  if (presented.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(storedHash, "utf8"));
}

/** True when the given expiry instant is at or before `now`. */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
