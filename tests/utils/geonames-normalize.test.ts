/**
 * Unit tests for `normalizeGazetteerName` in `src/utils/geonames-normalize.ts`.
 *
 * DB-free. This normaliser is the single source of truth shared by the
 * importer (which writes `name_norm`) and the resolver (which normalises the
 * query) — so these tests pin the exact algorithm. If it changes, the stored
 * data and the lookup key would silently diverge, so a change here should be
 * a deliberate, reviewed decision that triggers a gazetteer re-import.
 */

import { describe, it, expect } from "vitest";
import { hasArabic, normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";

describe("normalizeGazetteerName", () => {
  it("strips combining diacritics after NFKD decomposition", () => {
    // "Nyala" with a combining acute on the a decomposes and the mark drops.
    expect(normalizeGazetteerName("Nyála")).toBe("nyala");
    expect(normalizeGazetteerName("Kadugli")).toBe("kadugli");
  });

  it("lowercases and reduces punctuation to spaces, collapsing runs", () => {
    expect(normalizeGazetteerName("Khashm al-Girba")).toBe("khashm al girba");
    expect(normalizeGazetteerName("Wad al-Hilaywah")).toBe("wad al hilaywah");
  });

  it("collapses interior whitespace and trims the ends", () => {
    expect(normalizeGazetteerName("  Al   Fashir  ")).toBe("al fashir");
  });

  it("keeps alphanumerics and drops everything else", () => {
    expect(normalizeGazetteerName("Ed Da'ein (Locality)")).toBe("ed da ein locality");
    expect(normalizeGazetteerName("Zone 3")).toBe("zone 3");
  });

  it("returns an empty string for input with no alphanumeric content", () => {
    expect(normalizeGazetteerName("—")).toBe("");
    expect(normalizeGazetteerName("   ")).toBe("");
  });

  describe("Arabic", () => {
    it("keeps Arabic letters instead of blanking them", () => {
      expect(normalizeGazetteerName("كادقلي")).toBe("كادقلي");
      expect(normalizeGazetteerName("أم درمان")).toBe("ام درمان");
    });

    it("strips vowel marks and tatweel", () => {
      expect(normalizeGazetteerName("الفاشِر")).toBe("الفاشر");
      expect(normalizeGazetteerName("كـادقلي")).toBe("كادقلي");
    });

    it("folds hamza seats, alef wasla, alef maqsura and ta marbuta", () => {
      expect(normalizeGazetteerName("إبراهيم")).toBe("ابراهيم");
      expect(normalizeGazetteerName("آبار")).toBe("ابار");
      expect(normalizeGazetteerName("ٱلخرطوم")).toBe("الخرطوم");
      expect(normalizeGazetteerName("موسى")).toBe("موسي");
      expect(normalizeGazetteerName("القطينة")).toBe("القطينه");
    });

    it("folds Persian kaf and yeh, which GeoNames mixes in", () => {
      // GeoNames lists Rabak as both ربك and ربک.
      expect(normalizeGazetteerName("ربک")).toBe(normalizeGazetteerName("ربك"));
      expect(normalizeGazetteerName("رباک")).toBe("رباك");
    });

    it("handles mixed Latin and Arabic", () => {
      expect(normalizeGazetteerName("Kadugli (كادقلي)")).toBe("kadugli كادقلي");
    });
  });
});

describe("hasArabic", () => {
  it("detects Arabic letters only", () => {
    expect(hasArabic("كادقلي")).toBe(true);
    expect(hasArabic("Kadugli كادقلي")).toBe(true);
    expect(hasArabic("Kadugli")).toBe(false);
    expect(hasArabic("Nyála")).toBe(false);
  });
});
