/**
 * Normalises a place name for gazetteer matching: NFKD decompose, strip
 * combining diacritics, lowercase, reduce punctuation to spaces, collapse
 * whitespace.
 *
 * This is the single source of truth shared by the importer
 * (`scripts/import-geonames.ts`, which produces the stored `name_norm`) and
 * the resolver (`src/resolvers/gazetteer.resolver.ts`, which normalises the
 * query the same way). They MUST use identical normalisation — any
 * divergence silently breaks lookups with no error — so it lives here once
 * rather than being copied into both.
 *
 * @example normalizeGazetteerName("Khashm al-Girba") === "khashm al girba"
 */
export function normalizeGazetteerName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
