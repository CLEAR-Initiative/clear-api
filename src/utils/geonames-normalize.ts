/**
 * Normalises a place name for gazetteer matching: NFKD decompose, strip
 * combining diacritics, lowercase, reduce punctuation to spaces, collapse
 * whitespace. Arabic letters are kept (GeoNames carries Arabic alternate
 * names for most Sudanese districts and towns), with their vowel marks and
 * elongation removed and spelling variants folded to one form.
 *
 * This is the single source of truth shared by the importer
 * (`scripts/import-geonames.ts`, which produces the stored `name_norm`) and
 * the resolver (`src/resolvers/gazetteer.resolver.ts`, which normalises the
 * query the same way). They MUST use identical normalisation — any
 * divergence silently breaks lookups with no error — so it lives here once
 * rather than being copied into both. Changing it requires a re-import.
 *
 * @example normalizeGazetteerName("Khashm al-Girba") === "khashm al girba"
 * @example normalizeGazetteerName("الفاشِر") === "الفاشر"
 */

// Harakat, tanwin, shadda, sukun, the hamza/madda marks NFKD splits off
// أ إ آ ؤ ئ (so those fold to ا و ي), superscript alef, and tatweel.
const ARABIC_MARKS = /[ً-ٰٟـ]/g;

// Variants that differ only in spelling convention, folded to one letter.
const ARABIC_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/ٱ/g, "ا"], // ٱ alef wasla → ا
  [/ى/g, "ي"], // ى alef maqsura → ي
  [/ی/g, "ي"], // ی Persian yeh → ي
  [/ک/g, "ك"], // ک keheh → ك
  [/ة/g, "ه"], // ة ta marbuta → ه
];

/** True when the string contains an Arabic letter. */
export function hasArabic(s: string): boolean {
  return /[ء-يٮ-ۓ]/.test(s);
}

export function normalizeGazetteerName(s: string): string {
  let out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .replace(ARABIC_MARKS, "");
  for (const [pattern, letter] of ARABIC_FOLDS) out = out.replace(pattern, letter);
  return out
    .toLowerCase()
    .replace(/[^a-z0-9 ء-يٮ-ۓ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
