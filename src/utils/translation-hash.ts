import { createHash } from "node:crypto";
import type { TranslatableEntityType } from "./translation-loader.js";

/**
 * Per-field SHA-256 hashes of the canonical source text. Stored on
 * `translations.source_hashes` alongside the translated data so the
 * pipeline can detect *which field* on the canonical row changed and
 * re-translate only that field across every locale.
 *
 * The hash is intentionally computed from the *source* (canonical
 * English) string/JSON, not the translation. Comparing the stored hash
 * against a fresh hash of the current canonical row tells us whether
 * the locale row is stale.
 */
export type SourceHashes = Record<string, string>;

/**
 * Hash a single value. Strings are hashed as UTF-8 bytes; other JSON
 * values are stringified with sorted keys so equivalent objects produce
 * equal hashes regardless of insertion order. Null / undefined hash to
 * a sentinel so an empty field still produces a deterministic value.
 */
function hashValue(value: unknown): string {
  const h = createHash("sha256");
  if (value === null || value === undefined) {
    h.update("\0null");
  } else if (typeof value === "string") {
    h.update(value);
  } else {
    h.update(stableStringify(value));
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * JSON.stringify with deterministically sorted object keys. Two
 * structurally-equal JSON values produce the same string regardless of
 * key insertion order, which is what we need for hash equality.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Canonical-row shape per entity type — describes which fields get
 * hashed. Keep in sync with the resolver overlays in
 * src/resolvers/{event,crisis,location}.resolver.ts. Adding a new
 * translatable field means adding it here AND adding a resolver
 * overlay AND teaching the pipeline to translate it.
 */
const HASH_FIELDS: Record<TranslatableEntityType, readonly string[]> = {
  event:    ["title", "description"],
  crisis:   ["title", "summary", "scenarios", "needs"],
  location: ["name"],
};

/**
 * Build `{ field: sha256:... }` for every translatable field of the
 * given entity. Fields not present on `canonical` are still hashed (as
 * null) so the result has a stable shape per entity_type — the pipeline
 * and the staleness check both rely on that.
 */
export function computeSourceHashes(
  entityType: TranslatableEntityType,
  canonical: Record<string, unknown>,
): SourceHashes {
  const out: SourceHashes = {};
  for (const field of HASH_FIELDS[entityType]) {
    out[field] = hashValue(canonical[field]);
  }
  return out;
}

/**
 * Diff two hash sets — returns the field names whose hashes differ.
 * Used by the pipeline's "only re-translate changed fields" path: feed
 * it the freshly-computed canonical hashes and the stored
 * source_hashes from a translation row.
 */
export function staleFields(
  current: SourceHashes,
  stored: SourceHashes | null | undefined,
): string[] {
  if (!stored) return Object.keys(current);
  const out: string[] = [];
  for (const [field, hash] of Object.entries(current)) {
    if (stored[field] !== hash) out.push(field);
  }
  return out;
}
