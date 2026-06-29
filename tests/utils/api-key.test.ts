/**
 * Unit tests for the API-key primitives in `src/utils/api-key.ts`.
 * Pure crypto — no DB, no env. Always runs.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateApiKey, hashKey } from "../../src/utils/api-key.js";

describe("hashKey", () => {
  it("is a deterministic SHA-256 hex digest", () => {
    const key = "sk_live_example";
    expect(hashKey(key)).toBe(
      createHash("sha256").update(key).digest("hex"),
    );
  });

  it("produces a 64-char hex string", () => {
    expect(hashKey("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different hashes for different inputs", () => {
    expect(hashKey("a")).not.toBe(hashKey("b"));
  });
});

describe("generateApiKey", () => {
  it("returns a plaintext key with the sk_live_ prefix", () => {
    const { plaintextKey } = generateApiKey();
    expect(plaintextKey.startsWith("sk_live_")).toBe(true);
  });

  it("returns a prefix that is the sk_live_ marker plus the first 8 key chars", () => {
    const { plaintextKey, prefix } = generateApiKey();
    expect(prefix.startsWith("sk_live_")).toBe(true);
    // prefix === "sk_live_" + first 8 chars of the random part.
    expect(plaintextKey.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBe("sk_live_".length + 8);
  });

  it("returns keyHash = hashKey(plaintextKey)", () => {
    const { plaintextKey, keyHash } = generateApiKey();
    expect(keyHash).toBe(hashKey(plaintextKey));
  });

  it("generates a unique key on each call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintextKey).not.toBe(b.plaintextKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});
