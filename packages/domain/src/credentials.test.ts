import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./credentials.js";

const SECRET = "test-encryption-secret";

describe("credential encryption", () => {
  it("round-trips AES-256-GCM payloads", () => {
    const payload = encryptSecret('{"accessKeyId":"AKIA","secret":"s3cr3t"}', SECRET);
    expect(payload.startsWith("v1.")).toBe(true);
    expect(decryptSecret(payload, SECRET)).toBe('{"accessKeyId":"AKIA","secret":"s3cr3t"}');
  });

  it("uses a fresh nonce per encryption", () => {
    const a = encryptSecret("same", SECRET);
    const b = encryptSecret("same", SECRET);
    expect(a).not.toBe(b);
  });

  it("fails authentication with the wrong key", () => {
    const payload = encryptSecret("data", SECRET);
    expect(() => decryptSecret(payload, "other-secret")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptSecret("data", SECRET);
    const parts = payload.split(".");
    parts[3] = Buffer.from("forged").toString("base64url");
    expect(() => decryptSecret(parts.join("."), SECRET)).toThrow();
  });

  it("rejects unknown payload versions", () => {
    expect(() => decryptSecret("v0.a.b.c", SECRET)).toThrow(/format/i);
  });
});
