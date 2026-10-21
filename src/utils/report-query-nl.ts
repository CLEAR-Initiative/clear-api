/**
 * Deterministic natural-language → structured-filter parser for the report
 * search (Cap 3, "fetch me the UNHCR report on X between these dates").
 *
 * This is the "NL on top of structured" layer: it does NOT call an LLM (clear-api
 * has no LLM client — only the embedding provider). It extracts the handful of
 * structured dimensions the report search accepts from common phrasings:
 *   - `source`   — a humanitarian publisher/acronym mentioned (UNHCR, OCHA, …),
 *                  passed through as the source substring filter.
 *   - `published{From,To}` — a publication-date window from date phrases
 *                  ("between March 2024 and June 2024", "in 2023", "last 6 months").
 *   - `topicalQuery` — what's left after stripping the above and command filler,
 *                  used as the semantic query (empty → the recency listing path).
 *
 * Country scoping is intentionally NOT done here — it needs the locations table,
 * so the resolver resolves it against the question separately. The parser is pure
 * and dependency-free so it's trivially unit-testable and the resolver can surface
 * exactly what was understood back to the caller (who can confirm or override).
 */

export interface InterpretedReportQuery {
  /** Residual topical text for the semantic search (may be empty). */
  topicalQuery: string;
  /** Publisher/source substring (e.g. "UNHCR"); null when none recognised. */
  source: string | null;
  /** Inclusive publication-date window; null ends are open. */
  publishedFrom: Date | null;
  publishedTo: Date | null;
}

// Humanitarian publishers / sources we recognise by name or acronym. Matched
// case-insensitively on a word boundary; the canonical form is used as the
// (ILIKE) source filter. Ordered longest-first so "Save the Children" wins over
// a bare token. Extend freely — an unmatched source just falls through to the
// topical query, which still finds the report by content.
const KNOWN_SOURCES: string[] = [
  "Save the Children",
  "UNHCR", "UNICEF", "UNOCHA", "OCHA", "WFP", "WHO", "FAO", "IOM", "UNDP",
  "UNFPA", "OHCHR", "UNRWA", "IFRC", "ICRC", "NRC", "DRC", "ACLED", "REACH",
  "FEWS NET", "FEWSNET", "IPC", "MSF", "Oxfam", "CARE", "Mercy Corps",
  "ReliefWeb", "DTM",
];

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// Command / filler words stripped from the residual topical query so a pure
// "fetch me the reports" with no real topic collapses to empty (→ listing path)
// rather than searching for the noise word "reports".
const FILLER = new Set([
  "please", "fetch", "find", "get", "show", "give", "list", "pull", "me", "us",
  "the", "a", "an", "all", "any", "some", "report", "reports", "document",
  "documents", "doc", "docs", "related", "relating", "about", "on", "regarding",
  "concerning", "re", "for", "of", "from", "to", "with", "and", "or", "that",
  "which", "is", "are", "was", "were", "published", "dated", "between", "during",
  "in", "within", "over", "past", "last", "since", "me", "i", "want", "need",
  "looking", "search", "searching", "find",
]);

function startOfMonthUTC(year: number, month1: number): Date {
  return new Date(Date.UTC(year, month1 - 1, 1, 0, 0, 0, 0));
}
function endOfMonthUTC(year: number, month1: number): Date {
  // Day 0 of the next month = last day of this month, end-of-day.
  return new Date(Date.UTC(year, month1, 0, 23, 59, 59, 999));
}

interface DateParse {
  from: Date | null;
  to: Date | null;
  /** The substrings matched, so the caller can strip them from the topical text. */
  matched: string[];
}

/** Parse the first date expression found. Order matters: ranges before single
 *  points so "between A and B" isn't half-consumed by the single-month rule. */
function parseDates(lower: string): DateParse {
  const none: DateParse = { from: null, to: null, matched: [] };

  // between/from <month> <year> and/to <month> <year>
  let m = lower.match(
    new RegExp(`(?:between|from)\\s+${MONTH_RE}\\s+(\\d{4})\\s+(?:and|to|-|–|until|through)\\s+${MONTH_RE}\\s+(\\d{4})`),
  );
  if (m) {
    return {
      from: startOfMonthUTC(Number(m[2]), MONTHS[m[1]!]!),
      to: endOfMonthUTC(Number(m[4]), MONTHS[m[3]!]!),
      matched: [m[0]!],
    };
  }

  // between/from <year> and/to <year>
  m = lower.match(/(?:between|from)\s+(\d{4})\s+(?:and|to|-|–|until|through)\s+(\d{4})/);
  if (m) {
    return {
      from: startOfMonthUTC(Number(m[1]), 1),
      to: endOfMonthUTC(Number(m[2]), 12),
      matched: [m[0]!],
    };
  }

  // in/during <month> <year>
  m = lower.match(new RegExp(`(?:in|during|for)\\s+${MONTH_RE}\\s+(\\d{4})`));
  if (m) {
    const y = Number(m[2]);
    const mo = MONTHS[m[1]!]!;
    return { from: startOfMonthUTC(y, mo), to: endOfMonthUTC(y, mo), matched: [m[0]!] };
  }

  // since/after <month> <year>  → open-ended to now
  m = lower.match(new RegExp(`(?:since|after)\\s+${MONTH_RE}\\s+(\\d{4})`));
  if (m) {
    return { from: startOfMonthUTC(Number(m[2]), MONTHS[m[1]!]!), to: null, matched: [m[0]!] };
  }

  // last/past N days|weeks|months|years → now-N to now
  m = lower.match(/(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const now = new Date();
    const from = new Date(now);
    if (unit === "day") from.setUTCDate(from.getUTCDate() - n);
    else if (unit === "week") from.setUTCDate(from.getUTCDate() - n * 7);
    else if (unit === "month") from.setUTCMonth(from.getUTCMonth() - n);
    else from.setUTCFullYear(from.getUTCFullYear() - n);
    return { from, to: now, matched: [m[0]!] };
  }

  // since/after <year> → open-ended to now
  m = lower.match(/(?:since|after)\s+(\d{4})/);
  if (m) {
    return { from: startOfMonthUTC(Number(m[1]), 1), to: null, matched: [m[0]!] };
  }

  // in/during <year>  (bare 4-digit year, bounded so it's not part of a larger number)
  m = lower.match(/(?:in|during|for)\s+(\d{4})(?!\d)/);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1990 && y <= 2100) {
      return { from: startOfMonthUTC(y, 1), to: endOfMonthUTC(y, 12), matched: [m[0]!] };
    }
  }

  return none;
}

/** Parse a natural-language report question into structured search arguments. */
export function interpretReportQuestion(question: string): InterpretedReportQuery {
  const original = question.trim();
  const lower = original.toLowerCase();

  // Source: first recognised publisher (longest-first list).
  let source: string | null = null;
  for (const s of KNOWN_SOURCES) {
    const re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(original)) {
      source = s;
      break;
    }
  }

  const dates = parseDates(lower);

  // Build the residual topical query: drop the matched date phrase(s) and the
  // source mention, then drop command/filler words. If nothing meaningful is
  // left it's an empty string → the resolver uses the recency listing path.
  let residual = original;
  for (const phrase of dates.matched) {
    residual = residual.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  }
  if (source) {
    residual = residual.replace(new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ");
  }
  const topicalQuery = residual
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !FILLER.has(w.toLowerCase().replace(/[^a-z0-9]/gi, "")))
    .join(" ")
    .trim();

  return { topicalQuery, source, publishedFrom: dates.from, publishedTo: dates.to };
}
