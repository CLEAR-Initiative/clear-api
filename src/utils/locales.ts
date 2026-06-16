/**
 * Locale set the platform translates content for. `en` is the canonical
 * source; every other entry is a target locale stored in the
 * `translations` sidecar table.
 *
 * BCP-47 lowercased — matches `user.language` on input and the
 * `translations.locale` column on storage. Adding a new locale here is
 * the single switch the pipeline reads to know what to translate to.
 */
export const SUPPORTED_LOCALES = ["en", "ar", "fr", "fa", "ps"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Pick the first supported locale from an `Accept-Language` header value,
 * e.g. `"fr-FR,fr;q=0.9,en;q=0.8"` → `"fr"`. Returns null if none match,
 * letting the caller fall through to the user.language preference or
 * DEFAULT_LOCALE. We honour quality values implicitly by trusting the
 * client's token order — `q=` is the secondary signal and clients
 * already sort their list accordingly.
 */
export function pickAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;
    // Drop the region subtag — we only support primary languages.
    const base = tag.split("-")[0];
    if (base && isSupportedLocale(base)) return base;
  }
  return null;
}
