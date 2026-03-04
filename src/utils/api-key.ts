import { randomBytes, createHash } from "node:crypto";

const KEY_PREFIX = "sk_live_";
const RANDOM_BYTES = 32; // 256 bits -> 48 base64url chars

/**
 * Generate a new API key. The plaintext key is returned once and must never be stored.
 */
export function generateApiKey() {
  const randomPart = randomBytes(RANDOM_BYTES).toString("base64url");
  const plaintextKey = `${KEY_PREFIX}${randomPart}`;
  const prefix = `${KEY_PREFIX}${randomPart.slice(0, 8)}`;
  const keyHash = hashKey(plaintextKey);
  return { plaintextKey, prefix, keyHash };
}

/**
 * SHA-256 hash a plaintext API key. Used at creation and at lookup time.
 */
export function hashKey(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey).digest("hex");
}
