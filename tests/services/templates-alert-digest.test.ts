/**
 * Unit tests for the `alertDigest` email template.
 *
 * The digest is new as a thing that actually gets sent (clear #1731): the
 * template existed but nothing ever called it, so it had no locale support and
 * no coverage. These tests pin the two properties that matter to a recipient —
 * their own language, and an honest count when the list is capped.
 *
 * No mocks: the real template is exercised.
 */

import { describe, it, expect } from "vitest";
import { alertDigest } from "../../src/services/messaging/templates.js";

const items = [
  { title: "Battles in Blue Nile", description: "Shelling reported", url: "https://app.test/e/1" },
  { title: "Flooding in Kassala", description: null, url: "https://app.test/e/2" },
];

describe("alertDigest — locale", () => {
  it("renders English chrome and the alert count by default", () => {
    const { subject, textBody, htmlBody } = alertDigest("Ana", items, {
      dashboardUrl: "https://app.test",
    });
    expect(subject).toBe("Alert Digest (2) - CLEAR Platform");
    expect(textBody).toContain("Hi Ana,");
    expect(textBody).toContain("Here are the 2 alerts matching your subscriptions:");
    expect(textBody).toContain("1. Battles in Blue Nile - Shelling reported");
    expect(textBody).toContain("2. Flooding in Kassala");
    expect(htmlBody).toContain('<html lang="en" dir="ltr">');
    expect(htmlBody).toContain("View All Alerts");
  });

  it("renders Arabic chrome right-to-left, including the document direction", () => {
    const { subject, textBody, htmlBody } = alertDigest("أمل", items, {
      dashboardUrl: "https://app.test",
      locale: "ar",
    });
    expect(subject).toContain("ملخص التنبيهات (2)");
    expect(textBody).toContain("مرحبًا أمل،");
    expect(htmlBody).toContain('<html lang="ar" dir="rtl">');
    expect(htmlBody).toContain("عرض جميع التنبيهات");
    // The accent bar and text alignment flip with the script.
    expect(htmlBody).toContain("border-right: 3px solid #E85D3D");
    expect(htmlBody).not.toContain("border-left: 3px solid #E85D3D");
  });

  it("renders French and Spanish chrome", () => {
    expect(alertDigest("Luc", items, { dashboardUrl: "u", locale: "fr" }).subject).toContain(
      "Récapitulatif d'alertes (2)",
    );
    expect(alertDigest("Sofía", items, { dashboardUrl: "u", locale: "es" }).subject).toContain(
      "Resumen de alertas (2)",
    );
  });

  it("falls back to English for a locale it has no strings for", () => {
    // @ts-expect-error — deliberately passing an unsupported locale.
    const { subject } = alertDigest("Ana", items, { dashboardUrl: "u", locale: "de" });
    expect(subject).toBe("Alert Digest (2) - CLEAR Platform");
  });
});

describe("alertDigest — capped lists", () => {
  it("reports the true total and says how many were not listed", () => {
    const { subject, textBody, htmlBody } = alertDigest("Ana", items, {
      dashboardUrl: "https://app.test",
      totalCount: 48,
    });
    // The recipient is told 48, not the 2 the body happens to list.
    expect(subject).toBe("Alert Digest (48) - CLEAR Platform");
    expect(textBody).toContain("Here are the 48 alerts matching your subscriptions:");
    expect(textBody).toContain("+46 more");
    expect(htmlBody).toContain("+46 more");
  });

  it("says nothing about overflow when the list is complete", () => {
    const { textBody, htmlBody } = alertDigest("Ana", items, {
      dashboardUrl: "https://app.test",
      totalCount: 2,
    });
    expect(textBody).not.toContain("more");
    expect(htmlBody).not.toContain("+0 more");
  });

  it("localises the overflow suffix", () => {
    const { textBody } = alertDigest("أمل", items, {
      dashboardUrl: "u",
      locale: "ar",
      totalCount: 5,
    });
    expect(textBody).toContain("+3 المزيد");
  });
});
