import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const FORMAT_VERSION = "v1";

/**
 * Derive the 256-bit data-encryption key from the configured secret. The
 * environment supplies a high-entropy string (see CREDENTIAL_ENCRYPTION_KEY);
 * hashing normalizes any encoding to exactly 32 bytes.
 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypt relay credentials with AES-256-GCM (architecture §10). Output is a
 * compact `v1.<iv>.<tag>.<ciphertext>` base64url string; the version prefix
 * leaves room for key rotation.
 */
export function encryptSecret(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv, tag, ciphertext]
    .map((part) => (Buffer.isBuffer(part) ? part.toString("base64url") : part))
    .join(".");
}

/**
 * Decrypt a payload produced by {@link encryptSecret}. Throws when the
 * version is unknown or the authentication tag does not verify.
 */
export function decryptSecret(payload: string, secret: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unsupported credential payload format");
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
