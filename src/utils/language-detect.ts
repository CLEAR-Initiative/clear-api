/**
 * Cheap, deterministic language detection for short free text — hotline
 * messages at intake. No LLM and no dependency: a script count plus a
 * distinctive-stopword vote, limited to the platform's locales
 * (utils/locales.ts). Returns null whenever it isn't confident, so a null
 * `ground_messages.language` means "unknown", never a guess.
 *
 * - Arabic script is unambiguous in practice for this platform (Sudan and
 *   neighbours), so a majority of Arabic letters is enough — Latin acronyms
 *   inside an Arabic message ("WFP", "MSF") don't flip it.
 * - Latin script is shared by en/fr/es (and Somali, Swahili, … which we
 *   don't detect), so it takes stopword evidence: the best-scoring language
 *   must beat the runner-up outright. No hits, or a tie, is null.
 * - Any other dominant script (Ethiopic, …) is null.
 */

export type DetectedLanguage = "ar" | "en" | "fr" | "es";

/** Fewer letters than this is too little to call (e.g. "ok", "؟"). */
const MIN_LETTERS = 3;

/** Stopwords distinctive to one language. Words the three share ("a", "de",
 * "la", "en", "no", "que", "un", "se", "on") are deliberately left out — they
 * would vote for two languages at once. So are Spanish "el" / "al" / "lo" /
 * "su": the Arabic article in romanised place names ("El Fasher",
 * "al Geneina") and romanised Arabic ("ana fi el souq") would read as Spanish. */
const STOPWORDS: Record<Exclude<DetectedLanguage, "ar">, ReadonlySet<string>> = {
  en: new Set([
    "the", "and", "is", "are", "was", "were", "of", "to", "in", "at", "with",
    "for", "from", "this", "that", "there", "we", "they", "have", "has", "not",
    "it", "be", "been", "our", "you", "my", "by", "but", "or", "need", "near",
  ]),
  fr: new Set([
    "le", "les", "des", "du", "est", "et", "une", "dans", "pour", "sur",
    "avec", "qui", "pas", "nous", "ils", "sont", "au", "aux", "ce", "cette",
    "il", "à", "été", "très", "l",
  ]),
  es: new Set([
    "los", "las", "del", "está", "están", "es", "y", "una", "por", "para",
    "con", "pero", "hay", "muy", "sus", "fue", "nosotros", "ellos",
  ]),
};

/** Strip what carries no language signal before counting: URLs and the
 * phone-redaction placeholder (English words inserted at persistence). */
function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\[phone redacted\]/gi, " ");
}

export function detectLanguage(text: string | null | undefined): DetectedLanguage | null {
  if (!text) return null;
  const clean = stripNoise(text);

  const letters = clean.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return null;
  const arabic = clean.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  const latin = clean.match(/\p{Script=Latin}/gu)?.length ?? 0;

  if (arabic * 2 > letters) return "ar";
  if (latin * 2 <= letters) return null;

  const words = clean.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = (Object.keys(STOPWORDS) as Array<keyof typeof STOPWORDS>)
    .map((lang) => ({ lang, hits: words.filter((w) => STOPWORDS[lang].has(w)).length }))
    .sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scores;
  if (!best || best.hits === 0 || best.hits === runnerUp?.hits) return null;
  return best.lang;
}
