/**
 * An alert title that mixes English and Arabic (Exponential #1258) reads in
 * its own direction in the alert email and the digest, whatever the
 * direction of the email.
 */
import { describe, expect, it } from "vitest";
import { alertDigest, alertNotification, textDirection } from "../../src/services/messaging/templates.js";

const MIXED = "Explosions and forced displacement in Al-Kanabi (الكنابي), Northern";
const ARABIC = "انفجارات وتهجير قسري في الكنابي";

const h1 = (html: string) => /<h1[^>]*>/.exec(html)![0];

describe("textDirection", () => {
  it("follows the first strong character", () => {
    expect(textDirection(MIXED)).toBe("ltr");
    expect(textDirection(ARABIC)).toBe("rtl");
    // Digits, punctuation and spaces are not strong: the first letter decides.
    expect(textDirection("12 - (الكنابي) Al-Kanabi")).toBe("rtl");
    expect(textDirection("#2026: Flood in Sennar")).toBe("ltr");
    expect(textDirection("שלום")).toBe("rtl");
  });

  it("is left-to-right for a text with no letters", () => {
    expect(textDirection("")).toBe("ltr");
    expect(textDirection("123 !?")).toBe("ltr");
    expect(textDirection(null)).toBe("ltr");
  });
});

describe("alert email title", () => {
  it("keeps an English-led title left-to-right inside an Arabic email", () => {
    const { htmlBody } = alertNotification("Amal", MIXED, null, "https://app.test/alert/1", { locale: "ar" });
    expect(htmlBody).toContain('<html lang="ar" dir="rtl">');
    expect(h1(htmlBody)).toContain('dir="ltr"');
    // It stays on the side the email reads from.
    expect(h1(htmlBody)).toContain("text-align: right");
    expect(htmlBody).toContain(`>${MIXED}</h1>`);
  });

  it("keeps an Arabic title right-to-left inside an English email", () => {
    const { htmlBody } = alertNotification("Ana", ARABIC, null, "https://app.test/alert/1", { locale: "en" });
    expect(htmlBody).toContain('<html lang="en" dir="ltr">');
    expect(h1(htmlBody)).toContain('dir="rtl"');
    expect(h1(htmlBody)).toContain("text-align: left");
  });

  it("changes nothing for an English title in an English email", () => {
    const { htmlBody } = alertNotification("Ana", "Flood in Sennar", null, "https://app.test/alert/1");
    expect(h1(htmlBody)).toContain('dir="ltr"');
    expect(h1(htmlBody)).toContain("text-align: left");
  });

  it("writes no direction marks into the subject or the text body", () => {
    const { subject, textBody } = alertNotification("Amal", MIXED, null, "https://app.test/alert/1", { locale: "ar" });
    expect(subject + textBody).not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    expect(subject).toContain(MIXED);
  });
});

describe("alert digest titles", () => {
  it("gives each title its own direction", () => {
    const { htmlBody } = alertDigest(
      "Ana",
      "daily",
      [
        { title: MIXED, description: null, url: "https://app.test/alert/1" },
        { title: ARABIC, description: null, url: "https://app.test/alert/2" },
      ],
      "https://app.test",
    );
    expect(htmlBody).toMatch(new RegExp(`<p dir="ltr"[^>]*>${MIXED.replace(/[()]/g, "\\$&")}</p>`));
    expect(htmlBody).toMatch(new RegExp(`<p dir="rtl"[^>]*>${ARABIC}</p>`));
  });
});
