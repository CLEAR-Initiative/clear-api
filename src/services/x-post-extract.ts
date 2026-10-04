/**
 * X (Twitter) post extraction for hotline messages.
 *
 * Reporters in the field share posts into the hotline from the X app's
 * share sheet ("Share via… → WhatsApp"), which sends a bare link like
 * https://x.com/someone/status/1834…?s=46. A link alone tells a triage
 * operator nothing, so on ingest we resolve each X link to the post's
 * text, author and timestamp and store it alongside the message
 * (groundMessages.linkedPosts). The reporter's own text is never changed.
 *
 * Two fetchers, picked by configuration:
 *
 *   - X API v2 (`GET /2/tweets/:id`) when X_API_BEARER_TOKEN is set. Paid
 *     tier, but returns full long-form text (note_tweet) and a precise
 *     created_at.
 *   - oEmbed (publish.twitter.com/oembed) otherwise. Official, free and
 *     unauthenticated; returns the embed HTML, from which we parse text,
 *     author and date. Text of long posts can be truncated and dates are
 *     day-precision only — good enough for triage.
 *
 * Extraction is BEST-EFFORT: every failure (deleted/protected post,
 * timeout, rate limit) is recorded per post as status "failed" with a
 * short error, and never fails the ingest. Fetched text is phone-redacted
 * like the message itself.
 */

import { redactPhoneNumbers } from "./whatsapp-export.js";

/** One X post referenced by a hotline message — the JSON shape stored in
 * groundMessages.linkedPosts and served as GroundLinkedPost. */
// A type alias (not an interface) so it is assignable to Prisma's JSON input.
export type LinkedPost = {
  platform: "x";
  /** Canonical URL, https://x.com/{handle}/status/{id} (or /i/status/{id}
   * when the shared link carried no handle). */
  url: string;
  postId: string;
  status: "ok" | "failed";
  /** Display name and @handle (without the "@"), when resolved. */
  authorName: string | null;
  authorHandle: string | null;
  /** Post text, phone-redacted. Null when the fetch failed. */
  text: string | null;
  /** ISO 8601. Day-precision when it came from oEmbed. */
  postedAt: string | null;
  /** Short reason when status is "failed". */
  error: string | null;
  fetchedAt: string;
};

export const X_POST_FETCH_TIMEOUT_MS = 5_000;
/** A message with dozens of links is spam, not a report — cap the work. */
export const MAX_LINKED_POSTS = 5;

const X_STATUS_RE =
  /\bhttps?:\/\/(?:(?:www|mobile|m)\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/(?:([A-Za-z0-9_]{1,15})\/status(?:es)?|i(?:\/web)?\/status)\/(\d{1,25})/gi;

/** X post links in `text`, deduped by post id, in order of appearance. */
export function extractXPostLinks(
  text: string,
): Array<{ postId: string; handle: string | null; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ postId: string; handle: string | null; url: string }> = [];
  for (const match of text.matchAll(X_STATUS_RE)) {
    const handle = match[1] && match[1].toLowerCase() !== "i" ? match[1] : null;
    const postId = match[2]!;
    if (seen.has(postId)) continue;
    seen.add(postId);
    links.push({
      postId,
      handle,
      url: handle ? `https://x.com/${handle}/status/${postId}` : `https://x.com/i/status/${postId}`,
    });
    if (links.length >= MAX_LINKED_POSTS) break;
  }
  return links;
}

type FetchFn = typeof fetch;
type ResolvedFields = Pick<LinkedPost, "authorName" | "authorHandle" | "text" | "postedAt">;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Parse oEmbed's blockquote:
 *   <blockquote class="twitter-tweet"><p lang="en" dir="ltr">TEXT</p>
 *   &mdash; Name (@handle) <a href="…">October 3, 2026</a></blockquote>
 */
export function parseOEmbedHtml(html: string): Pick<ResolvedFields, "text" | "postedAt"> & {
  authorHandle: string | null;
} {
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const text = p ? htmlToText(p[1]!) : null;
  const tail = p ? html.slice(p.index + p[0].length) : html;
  const handle = /\(@([A-Za-z0-9_]{1,15})\)/.exec(decodeHtmlEntities(tail));
  const dateMatch = /<a\b[^>]*>([^<]*)<\/a>\s*<\/blockquote>/i.exec(tail);
  let postedAt: string | null = null;
  if (dateMatch) {
    const parsed = Date.parse(`${decodeHtmlEntities(dateMatch[1]!).trim()} UTC`);
    if (Number.isFinite(parsed)) postedAt = new Date(parsed).toISOString();
  }
  return { text, postedAt, authorHandle: handle ? handle[1]! : null };
}

async function fetchViaOEmbed(url: string, fetchFn: FetchFn): Promise<ResolvedFields> {
  const endpoint = new URL("https://publish.twitter.com/oembed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("omit_script", "true");
  endpoint.searchParams.set("dnt", "true");
  const res = await fetchFn(endpoint, { signal: AbortSignal.timeout(X_POST_FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    // 404: deleted, never existed, or protected; 403: suspended/withheld.
    throw new Error(`oEmbed HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    html?: unknown;
    author_name?: unknown;
    author_url?: unknown;
  };
  if (typeof body.html !== "string") throw new Error("oEmbed response had no html");
  const parsed = parseOEmbedHtml(body.html);
  const urlHandle =
    typeof body.author_url === "string"
      ? (/\/([A-Za-z0-9_]{1,15})\/?$/.exec(body.author_url)?.[1] ?? null)
      : null;
  return {
    text: parsed.text,
    postedAt: parsed.postedAt,
    authorName: typeof body.author_name === "string" ? body.author_name : null,
    authorHandle: urlHandle ?? parsed.authorHandle,
  };
}

async function fetchViaXApi(
  postId: string,
  bearerToken: string,
  fetchFn: FetchFn,
): Promise<ResolvedFields> {
  const endpoint = new URL(`https://api.x.com/2/tweets/${postId}`);
  endpoint.searchParams.set("expansions", "author_id");
  endpoint.searchParams.set("tweet.fields", "created_at,note_tweet");
  endpoint.searchParams.set("user.fields", "name,username");
  const res = await fetchFn(endpoint, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(X_POST_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`X API HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      text?: string;
      created_at?: string;
      author_id?: string;
      note_tweet?: { text?: string };
    };
    includes?: { users?: Array<{ id: string; name?: string; username?: string }> };
    errors?: Array<{ title?: string; detail?: string }>;
  };
  if (!body.data) {
    const e = body.errors?.[0];
    throw new Error(`X API: ${e?.title ?? e?.detail ?? "no data"}`);
  }
  const author = body.includes?.users?.find((u) => u.id === body.data!.author_id);
  return {
    // note_tweet holds the untruncated text of long-form posts.
    text: body.data.note_tweet?.text ?? body.data.text ?? null,
    postedAt: body.data.created_at ?? null,
    authorName: author?.name ?? null,
    authorHandle: author?.username ?? null,
  };
}

/**
 * Resolve every X post link in `text`. Never throws; per-post failures
 * come back as status "failed". Posts are fetched concurrently.
 */
export async function resolveXPostLinks(
  text: string,
  options: { bearerToken?: string; fetchFn?: FetchFn; now?: () => Date } = {},
): Promise<LinkedPost[]> {
  const links = extractXPostLinks(text);
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  return Promise.all(
    links.map(async (link): Promise<LinkedPost> => {
      try {
        const fields = options.bearerToken
          ? await fetchViaXApi(link.postId, options.bearerToken, fetchFn)
          : await fetchViaOEmbed(link.url, fetchFn);
        const handle = fields.authorHandle ?? link.handle;
        return {
          platform: "x",
          url: handle ? `https://x.com/${handle}/status/${link.postId}` : link.url,
          postId: link.postId,
          status: "ok",
          authorName: fields.authorName,
          authorHandle: handle,
          text: fields.text === null ? null : redactPhoneNumbers(fields.text),
          postedAt: fields.postedAt,
          error: null,
          fetchedAt: now().toISOString(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          platform: "x",
          url: link.url,
          postId: link.postId,
          status: "failed",
          authorName: null,
          authorHandle: link.handle,
          text: null,
          postedAt: null,
          error: message.slice(0, 200),
          fetchedAt: now().toISOString(),
        };
      }
    }),
  );
}
