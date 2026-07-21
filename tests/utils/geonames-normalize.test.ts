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
import { normalizeGazetteerName } from "../../src/utils/geonames-normalize.js";

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
});
