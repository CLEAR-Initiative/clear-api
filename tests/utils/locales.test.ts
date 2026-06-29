/**
 * Unit tests for the locale helpers in `src/utils/locales.ts`.
 * Pure value logic — no DB, no env. Always runs.
 *
 * Covers `isSupportedLocale` (type guard) and `pickAcceptLanguage`
 * (Accept-Language parsing, region-subtag stripping, case/whitespace
 * normalisation, token-order priority, and the no-match fallthrough).
 * `SUPPORTED_LOCALES`, `DEFAULT_LOCALE` and `LOCALE_DIRECTION` are trivial
 * constants with no logic; they are asserted lightly below rather than
 * exhaustively, since they carry behavioural meaning the helpers rely on.
 */

import { describe, it, expect } from "vitest";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_DIRECTION,
  isSupportedLocale,
  pickAcceptLanguage,
} from "../../src/utils/locales.js";

describe("locale constants", () => {
  it("uses en as the canonical default locale", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("declares a BiDi direction for every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_DIRECTION[locale]).toMatch(/^(ltr|rtl)$/);
    }
    // ar is the right-to-left case the SSR HTML cares about.
    expect(LOCALE_DIRECTION.ar).toBe("rtl");
    expect(LOCALE_DIRECTION.en).toBe("ltr");
  });
});

describe("isSupportedLocale", () => {
  it("returns true for each supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it("returns false for an unsupported but plausible code", () => {
    expect(isSupportedLocale("de")).toBe(false);
    expect(isSupportedLocale("es")).toBe(false);
  });

  it("is case-sensitive (locales are stored lowercased)", () => {
    expect(isSupportedLocale("EN")).toBe(false);
    expect(isSupportedLocale("Ar")).toBe(false);
  });

  it("rejects region-tagged forms (only primary languages are supported)", () => {
    expect(isSupportedLocale("en-US")).toBe(false);
    expect(isSupportedLocale("fr-FR")).toBe(false);
  });

  it("rejects empty string and whitespace", () => {
    expect(isSupportedLocale("")).toBe(false);
    expect(isSupportedLocale(" en ")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
    expect(isSupportedLocale(["en"])).toBe(false);
    expect(isSupportedLocale({ locale: "en" })).toBe(false);
  });
});

describe("pickAcceptLanguage", () => {
  it("returns null for null / undefined / empty header", () => {
    expect(pickAcceptLanguage(null)).toBeNull();
    expect(pickAcceptLanguage(undefined)).toBeNull();
    expect(pickAcceptLanguage("")).toBeNull();
  });

  it("returns a bare supported tag", () => {
    expect(pickAcceptLanguage("fr")).toBe("fr");
  });

  it("strips the region subtag down to the primary language", () => {
    expect(pickAcceptLanguage("fr-FR")).toBe("fr");
    expect(pickAcceptLanguage("en-US")).toBe("en");
  });

  it("lowercases the tag before matching", () => {
    expect(pickAcceptLanguage("FR-fr")).toBe("fr");
    expect(pickAcceptLanguage("AR")).toBe("ar");
  });

  it("trims surrounding whitespace from each token", () => {
    expect(pickAcceptLanguage("  fr  ")).toBe("fr");
  });

  it("picks the first supported language in token order", () => {
    // de is unsupported and skipped; fr is the first supported token.
    expect(pickAcceptLanguage("de,fr;q=0.9,en;q=0.8")).toBe("fr");
  });

  it("honours token order over q-values (order is the primary signal)", () => {
    // ar appears first even though en carries a higher q; order wins.
    expect(pickAcceptLanguage("ar;q=0.1,en;q=0.9")).toBe("ar");
  });

  it("skips unsupported languages and returns the first supported one", () => {
    expect(pickAcceptLanguage("de-DE,es,en-GB")).toBe("en");
  });

  it("ignores q-value parameters when extracting the tag", () => {
    expect(pickAcceptLanguage("fr;q=0.5")).toBe("fr");
  });

  it("returns null when no token matches a supported locale", () => {
    expect(pickAcceptLanguage("de,es,it")).toBeNull();
    expect(pickAcceptLanguage("zh-CN")).toBeNull();
  });

  it("tolerates empty tokens / stray commas", () => {
    expect(pickAcceptLanguage(",,fr,")).toBe("fr");
    expect(pickAcceptLanguage("   ,  , ")).toBeNull();
  });

  it("returns a value that always passes isSupportedLocale", () => {
    const picked = pickAcceptLanguage("de,ar;q=0.7");
    expect(picked).not.toBeNull();
    expect(isSupportedLocale(picked)).toBe(true);
  });
});
