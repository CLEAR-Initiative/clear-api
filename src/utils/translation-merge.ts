/**
 * Deep-merge a translation overlay onto a canonical JSON value.
 *
 * The pipeline stores situation-analysis translations as the same nested
 * shape as the canonical `data`, but carrying ONLY the translated prose
 * leaves (summary text, bullet strings, sector needs, …) in their original
 * positions. Everything else — numbers, enums like sector severity, ids,
 * `source_report_ids`, coverage ratings — is deliberately absent from the
 * overlay so it can never be corrupted by translation.
 *
 * Merging the overlay over canonical therefore replaces exactly the prose
 * leaves and leaves the rest of the structure untouched:
 *   - objects  → merged key-by-key (canonical keys the overlay omits survive)
 *   - arrays   → merged element-by-element by index (canonical tail survives
 *                a shorter overlay; a SourcedBullet keeps its `source_report_ids`
 *                while its `description` is replaced)
 *   - leaves   → the overlay value wins, unless it is null/undefined, in which
 *                case the canonical value survives
 *
 * This is intentionally generic: clear-api holds no situation-specific field
 * map. The pipeline owns which fields are prose; the resolver only overlays
 * whatever nested shape it is handed.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMergeTranslation(canonical: unknown, overlay: unknown): unknown {
  // A missing overlay leaf never clobbers canonical.
  if (overlay === null || overlay === undefined) return canonical;

  if (isPlainObject(canonical) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...canonical };
    for (const [key, overlayValue] of Object.entries(overlay)) {
      out[key] = deepMergeTranslation(canonical[key], overlayValue);
    }
    return out;
  }

  if (Array.isArray(canonical) && Array.isArray(overlay)) {
    return canonical.map((item, i) =>
      i < overlay.length ? deepMergeTranslation(item, overlay[i]) : item,
    );
  }

  // Leaf (or a shape mismatch): the overlay replaces the canonical value.
  return overlay;
}
