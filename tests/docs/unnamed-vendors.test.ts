/**
 * Some data providers may not be named in public material. The public docs
 * (/docs) and the schema descriptions (introspection) must not name them.
 *
 * The served /docs page is generated from src/docs/template.ts and the
 * schema descriptions; CI checks docs-body.html is in sync with both.
 *
 * The names are kept here only as SHA-256 fingerprints, so this public test
 * does not name them either. To add one, append
 * sha256(<lowercase name with spaces and punctuation removed>).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UNNAMED = new Set([
  "ba839bfeed3c4bbcd20e38b07724f7b747751941609868243a98bd6e1b86fb0d",
]);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Words in `text` (and pairs of adjacent words, to catch a split name) whose fingerprint is listed. */
function unnamedHits(text: string): number {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    if (UNNAMED.has(sha256(words[i]!))) hits++;
    if (i + 1 < words.length && UNNAMED.has(sha256(words[i]! + words[i + 1]!))) hits++;
  }
  return hits;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Every file under src/schema/typeDefs: the descriptions there become the API reference and introspection. */
function typeDefFiles(): string[] {
  const dir = join(root, "src/schema/typeDefs");
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/schema/typeDefs/${f}`);
}

describe("public docs do not name unnamed providers", () => {
  it.each(["src/docs/template.ts", "src/docs/docs-body.html"])("%s", (file) => {
    expect(unnamedHits(read(file))).toBe(0);
  });

  it("the schema type definitions", () => {
    const files = typeDefFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => unnamedHits(read(f)) > 0)).toEqual([]);
  });

  it("the check itself still matches a listed name", () => {
    // Fingerprint of a made-up name, added only for this test.
    UNNAMED.add(sha256("examplevendor"));
    expect(unnamedHits("from Example Vendor and examplevendor:{id}")).toBe(2);
    UNNAMED.delete(sha256("examplevendor"));
  });
});
