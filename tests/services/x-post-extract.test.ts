/**
 * X post extraction: link detection across the URL shapes the share sheet
 * and mirrors produce, oEmbed HTML parsing, both fetchers, and that every
 * failure degrades to a per-post "failed" entry. Hermetic: injected fetch.
 */

import { describe, it, expect, vi } from "vitest";

import {
  extractXPostLinks,
  parseOEmbedHtml,
  resolveXPostLinks,
  MAX_LINKED_POSTS,
} from "../../src/services/x-post-extract.js";

const NOW = () => new Date("2026-10-04T12:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("extractXPostLinks", () => {
  it("finds share-sheet, twitter.com, mobile, mirror and /i/web links", () => {
    const links = extractXPostLinks(
      [
        "https://x.com/Reporter_1/status/1834000000000000001?s=46&t=abc",
        "http://twitter.com/other/status/1834000000000000002",
        "https://mobile.twitter.com/third/statuses/1834000000000000003",
        "https://fxtwitter.com/fourth/status/1834000000000000004/photo/1",
        "https://twitter.com/i/web/status/1834000000000000005",
      ].join(" "),
    );
    expect(links.map((l) => l.postId)).toEqual([
      "1834000000000000001",
      "1834000000000000002",
      "1834000000000000003",
      "1834000000000000004",
      "1834000000000000005",
    ]);
    expect(links[0]!.url).toBe("https://x.com/Reporter_1/status/1834000000000000001");
    expect(links[4]).toMatchObject({
      handle: null,
      url: "https://x.com/i/status/1834000000000000005",
    });
  });

  it("dedupes by post id, ignores non-post X links, and caps the count", () => {
    expect(
      extractXPostLinks("https://x.com/a/status/1 https://twitter.com/a/status/1"),
    ).toHaveLength(1);
    expect(extractXPostLinks("https://x.com/someone https://example.com/a/status/1")).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `https://x.com/a/status/${i + 1}`).join(" ");
    expect(extractXPostLinks(many)).toHaveLength(MAX_LINKED_POSTS);
  });
});

const OEMBED_HTML =
  '<blockquote class="twitter-tweet"><p lang="ar" dir="rtl">Line one &amp; more<br>line two ' +
  '<a href="https://t.co/x">#Sudan</a></p>&mdash; Some One (@someone) ' +
  '<a href="https://twitter.com/someone/status/123?ref_src=twsrc%5Etfw">October 3, 2026</a></blockquote>\n';

describe("parseOEmbedHtml", () => {
  it("extracts text, handle and date", () => {
    expect(parseOEmbedHtml(OEMBED_HTML)).toEqual({
      text: "Line one & more\nline two #Sudan",
      authorHandle: "someone",
      postedAt: "2026-10-03T00:00:00.000Z",
    });
  });
});

describe("resolveXPostLinks", () => {
  it("returns [] without fetching when there are no X links", async () => {
    const fetchFn = vi.fn();
    expect(await resolveXPostLinks("no links here", { fetchFn })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses oEmbed without a token, and redacts phone numbers in the post", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://publish.twitter.com");
      expect(url.searchParams.get("url")).toBe("https://x.com/someone/status/123");
      return jsonResponse({
        html: OEMBED_HTML.replace("Line one", "Call +249 912 345 678"),
        author_name: "Some One",
        author_url: "https://twitter.com/someone",
      });
    });
    const [post] = await resolveXPostLinks("look https://x.com/someone/status/123?s=20", {
      fetchFn: fetchFn as typeof fetch,
      now: NOW,
    });
    expect(post).toMatchObject({
      status: "ok",
      postId: "123",
      authorName: "Some One",
      authorHandle: "someone",
      postedAt: "2026-10-03T00:00:00.000Z",
      error: null,
      fetchedAt: "2026-10-04T12:00:00.000Z",
    });
    expect(post!.text).not.toContain("912 345 678");
  });

  it("uses the X API with a token, preferring long-form note_tweet text", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("https://api.x.com/2/tweets/123");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return jsonResponse({
        data: {
          id: "123",
          text: "truncated…",
          note_tweet: { text: "the full long post" },
          created_at: "2026-10-03T08:15:00.000Z",
          author_id: "u1",
        },
        includes: { users: [{ id: "u1", name: "Some One", username: "someone" }] },
      });
    });
    const [post] = await resolveXPostLinks("https://twitter.com/i/web/status/123", {
      bearerToken: "tok",
      fetchFn: fetchFn as typeof fetch,
      now: NOW,
    });
    expect(post).toMatchObject({
      status: "ok",
      text: "the full long post",
      postedAt: "2026-10-03T08:15:00.000Z",
      authorHandle: "someone",
      url: "https://x.com/someone/status/123",
    });
  });

  it("records failures per post instead of throwing", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("%2F1")) return jsonResponse({}, 404);
      throw new Error("network down");
    });
    const posts = await resolveXPostLinks("https://x.com/a/status/1 https://x.com/b/status/2", {
      fetchFn: fetchFn as typeof fetch,
      now: NOW,
    });
    expect(posts.map((p) => [p.status, p.error])).toEqual([
      ["failed", "oEmbed HTTP 404"],
      ["failed", "network down"],
    ]);
    expect(posts[0]).toMatchObject({ text: null, authorHandle: "a" });
  });
});
