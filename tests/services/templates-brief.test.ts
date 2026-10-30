/**
 * The Brief email: fixed sections in order, everything people or the
 * pipeline wrote escaped, and Markdown-lite links limited to http(s).
 */
import { describe, expect, it } from "vitest";
import {
  brief,
  briefMarkdownLite,
  type BriefEmailItem,
  type BriefEmailView,
} from "../../src/services/messaging/templates.js";

function item(over: Partial<BriefEmailItem> = {}): BriefEmailItem {
  return {
    title: "Flooding in Kassala",
    severity: 4,
    locationName: "Kassala",
    eventTypes: ["FL"],
    occurredAt: "2026-10-30T02:00:00.000Z",
    url: "https://app.test/event/ev-1",
    note: null,
    ...over,
  };
}

const count = (total: number) => ({
  total,
  bySeverity: [{ key: "4", count: total }],
  byType: [{ key: "FL", count: total }],
});

function view(over: Partial<BriefEmailView> = {}): BriefEmailView {
  return {
    title: "Daily Brief, Sudan",
    locationName: "Sudan",
    windowStart: new Date("2026-10-29T08:00:00Z"),
    windowEnd: new Date("2026-10-30T08:00:00Z"),
    summary: "A **calm** day.",
    closingNotes: "Next: the rains.",
    counts: { alert: count(1), event: count(2), signal: count(3) },
    groups: [
      { kind: "alert", items: [item({ title: "Alert one" })] },
      { kind: "event", items: [item({ title: "Event one", url: "https://app.test/event/ev-2" })] },
      { kind: "signal", items: [item({ title: "Signal one", url: "https://app.test/signal/s-1" })] },
    ],
    ...over,
  };
}

const live = { unsubscribeUrl: "https://api.test/briefs/unsubscribe?token=tok-1", isTest: false };

describe("brief email", () => {
  it("renders the sections in order, in HTML and in text", () => {
    const content = brief(view(), live);
    const order = ["Daily Brief, Sudan", "calm", "Counts", "Alert one", "Event one", "Signal one", "Next: the rains"];
    for (const body of [content.htmlBody, content.textBody.replace("COUNTS", "Counts")]) {
      const at = order.map((s) => body.indexOf(s));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
    expect(content.subject).toBe("Daily Brief, Sudan");
    expect(content.htmlBody).toContain("<strong>calm</strong>");
  });

  it("escapes HTML in the title, area, summary, notes and item fields", () => {
    const content = brief(
      view({
        title: "<img src=x onerror=alert(1)>",
        locationName: "<b>Area</b>",
        summary: "<script>alert('s')</script>",
        closingNotes: '<iframe src="https://evil.test">',
        groups: [
          {
            kind: "event",
            items: [
              item({
                title: "<script>t</script>",
                locationName: "<i>loc</i>",
                eventTypes: ["<x>"],
                note: '<a href="https://evil.test">n</a>',
              }),
            ],
          },
        ],
      }),
      live,
    );
    for (const raw of ["<img", "<b>Area", "<script>", "<iframe", "<i>loc", "<x>", '<a href="https://evil.test"']) {
      expect(content.htmlBody).not.toContain(raw);
    }
    expect(content.htmlBody).toContain("&lt;script&gt;t&lt;/script&gt;");
    expect(content.htmlBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("links item titles with from=email and marks items from before the window", () => {
    const old = item({ title: "Old one", occurredAt: "2026-10-20T00:00:00.000Z" });
    const content = brief(view({ groups: [{ kind: "event", items: [old, item()] }] }), live);
    expect(content.htmlBody).toContain('href="https://app.test/event/ev-1?from=email"');
    expect(content.textBody).toContain("from 20 Oct 2026");
    expect(content.textBody.match(/from \d+ \w+ \d{4}/g)).toHaveLength(1);
  });

  it("carries the recipient's unsubscribe link, and none on a test", () => {
    const content = brief(view(), live);
    expect(content.htmlBody).toContain('href="https://api.test/briefs/unsubscribe?token=tok-1"');
    expect(content.textBody).toContain("https://api.test/briefs/unsubscribe?token=tok-1");

    const test = brief(view(), { unsubscribeUrl: null, isTest: true });
    expect(test.subject).toBe("[TEST] Daily Brief, Sudan");
    expect(test.htmlBody).not.toContain("unsubscribe");
  });

  it("omits empty sections", () => {
    const content = brief(view({ summary: " ", closingNotes: "", counts: null, groups: [] }), live);
    expect(content.htmlBody).not.toContain(">Summary<");
    expect(content.htmlBody).not.toContain(">Counts<");
    expect(content.htmlBody).not.toContain(">Closing notes<");
    expect(content.htmlBody).toContain("No items picked.");
  });
});

describe("briefMarkdownLite", () => {
  it("renders bold, italic, bullets and http(s) links", () => {
    const html = briefMarkdownLite("**Bold** and *it*\n\n- one\n- [two](https://x.test/a?b=1&c=2)");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('<a href="https://x.test/a?b=1&amp;c=2"');
    expect(html).toContain(">two</a>");
  });

  it("drops links to anything but http or https, keeping their text", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "mailto:a@b.test", "//evil.test", "/relative"]) {
      const html = briefMarkdownLite(`see [here](${href})`);
      expect(html).not.toContain("<a ");
      expect(html).toContain("see here");
    }
  });

  it("can't be broken out of with quotes or angle brackets", () => {
    const html = briefMarkdownLite('[x](https://a.test/"onmouseover="alert(1)) <b>raw</b>');
    expect(html).not.toContain('"onmouseover');
    expect(html).not.toContain("<b>");
  });

  it("ignores emphasis markers inside link URLs", () => {
    const html = briefMarkdownLite("[a](https://x.test/*not*/here)");
    expect(html).toContain('href="https://x.test/*not*/here"');
    expect(html).not.toContain("<em>");
  });
});
