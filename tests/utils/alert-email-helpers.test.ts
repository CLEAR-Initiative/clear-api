/**
 * Unit tests for `src/utils/alert-email-helpers.ts` — the formatting +
 * transformation helpers behind alert notification emails.
 *
 * DB-free: the module only ever takes a `PrismaClient` as a function
 * argument (it's a type-only import), so there's nothing to `vi.mock`.
 * Where a helper queries the DB we hand it a stub object whose delegates
 * are `vi.fn()`s — the real Prisma client is never imported, so these
 * always run in CI without a database.
 *
 * Covered:
 *   - Pure formatters: severityToLabel, formatCount, normaliseUserLocale,
 *     pickLocalizedName.
 *   - DB-arg transformers (stubbed delegates): fetchEventLocalizedText,
 *     resolveEmailLocation, fetchEventSignalLocations, localizeLocationNames,
 *     resolveEventTypeLabel.
 *
 * Not covered (integration-only / out of scope): the actual email send /
 * provider path does not live in this module — it's wired up in the
 * notification resolver, which is tested separately against the messaging
 * mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  severityToLabel,
  formatCount,
  normaliseUserLocale,
  pickLocalizedName,
  fetchEventLocalizedText,
  resolveEmailLocation,
  fetchEventSignalLocations,
  localizeLocationNames,
  resolveEventTypeLabel,
} from "../../src/utils/alert-email-helpers.js";
import type { Locale } from "../../src/utils/locales.js";

describe("severityToLabel", () => {
  it("maps each known numeric severity to its label", () => {
    expect(severityToLabel(1)).toBe("MINIMAL");
    expect(severityToLabel(2)).toBe("LOW");
    expect(severityToLabel(3)).toBe("MEDIUM");
    expect(severityToLabel(4)).toBe("HIGH");
    expect(severityToLabel(5)).toBe("CRITICAL");
  });

  it("returns null for an out-of-range severity", () => {
    expect(severityToLabel(0)).toBeNull();
    expect(severityToLabel(6)).toBeNull();
  });

  it("returns null for null/undefined (not the 0-key)", () => {
    expect(severityToLabel(null)).toBeNull();
    expect(severityToLabel(undefined)).toBeNull();
  });
});

describe("formatCount", () => {
  it("renders sub-thousand values with locale grouping", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
  });

  it("renders thousands as a rounded K with no decimals", () => {
    expect(formatCount(1_000)).toBe("1K");
    expect(formatCount(1_500)).toBe("2K"); // toFixed(0) rounds
    expect(formatCount(12_345)).toBe("12K");
  });

  it("renders millions as a one-decimal M", () => {
    expect(formatCount(1_000_000)).toBe("1.0M");
    expect(formatCount(2_500_000)).toBe("2.5M");
  });

  it("coerces bigint input the same way as number input", () => {
    expect(formatCount(1_500n)).toBe("2K");
    expect(formatCount(3_000_000n)).toBe("3.0M");
    expect(formatCount(500n)).toBe("500");
  });
});

describe("normaliseUserLocale", () => {
  it("passes through a supported non-default locale", () => {
    expect(normaliseUserLocale("fr")).toBe("fr");
    expect(normaliseUserLocale("ar")).toBe("ar");
  });

  it("keeps 'en' as the default locale", () => {
    expect(normaliseUserLocale("en")).toBe("en");
  });

  it("collapses unsupported / null / undefined to the default locale", () => {
    expect(normaliseUserLocale("de")).toBe("en");
    expect(normaliseUserLocale("fr-FR")).toBe("en"); // region subtag is not a supported value
    expect(normaliseUserLocale(null)).toBe("en");
    expect(normaliseUserLocale(undefined)).toBe("en");
  });
});

describe("pickLocalizedName", () => {
  const cache = new Map<string, Map<Locale, string>>([
    ["loc1", new Map<Locale, string>([["fr", "Khartoum-FR"]])],
  ]);

  it("returns the canonical name when locationId is null/undefined", () => {
    expect(pickLocalizedName(cache, null, "fr", "Canon")).toBe("Canon");
    expect(pickLocalizedName(cache, undefined, "fr", "Canon")).toBe("Canon");
  });

  it("returns the translated name when present for the locale", () => {
    expect(pickLocalizedName(cache, "loc1", "fr", "Canon")).toBe("Khartoum-FR");
  });

  it("falls back to canonical when the locale has no translation", () => {
    expect(pickLocalizedName(cache, "loc1", "ar", "Canon")).toBe("Canon");
  });

  it("falls back to canonical when the location id is absent from the cache", () => {
    expect(pickLocalizedName(cache, "missing", "fr", "Canon")).toBe("Canon");
  });

  it("propagates a null canonical when nothing matches", () => {
    expect(pickLocalizedName(cache, "missing", "fr", null)).toBeNull();
  });
});

describe("fetchEventLocalizedText", () => {
  it("returns only the canonical en entry without querying when no other locales are requested", async () => {
    const findMany = vi.fn();
    const prisma = { translations: { findMany } };
    const out = await fetchEventLocalizedText(
      prisma as never,
      "evt1",
      "Title",
      "Desc",
      ["en"],
    );
    expect(out.size).toBe(1);
    expect(out.get("en")).toEqual({ title: "Title", description: "Desc" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries only the non-en locales and indexes translated rows by locale", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { locale: "fr", data: { title: "Titre", description: "Desc-FR" } },
    ]);
    const prisma = { translations: { findMany } };
    const out = await fetchEventLocalizedText(
      prisma as never,
      "evt1",
      "Title",
      "Desc",
      ["en", "fr", "ar"],
    );

    // The DB filter should request fr + ar (deduped, en excluded).
    const whereLocale = findMany.mock.calls[0][0].where.locale.in as string[];
    expect([...whereLocale].sort()).toEqual(["ar", "fr"]);

    expect(out.get("en")).toEqual({ title: "Title", description: "Desc" });
    expect(out.get("fr")).toEqual({ title: "Titre", description: "Desc-FR" });
  });

  it("falls back to canonical strings for a requested locale with no translation row", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { translations: { findMany } };
    const out = await fetchEventLocalizedText(
      prisma as never,
      "evt1",
      "Title",
      "Desc",
      ["fr"],
    );
    expect(out.get("fr")).toEqual({ title: "Title", description: "Desc" });
  });

  it("falls back per-field when a translation row carries a non-string field", async () => {
    const findMany = vi.fn().mockResolvedValue([
      // title present, description missing/non-string → description falls back.
      { locale: "fr", data: { title: "Titre", description: 123 } },
    ]);
    const prisma = { translations: { findMany } };
    const out = await fetchEventLocalizedText(
      prisma as never,
      "evt1",
      "Title",
      "Desc",
      ["fr"],
    );
    expect(out.get("fr")).toEqual({ title: "Titre", description: "Desc" });
  });
});

describe("resolveEmailLocation", () => {
  it("returns null for a null location", async () => {
    const prisma = { locations: { findMany: vi.fn() } };
    expect(await resolveEmailLocation(prisma as never, null)).toBeNull();
  });

  it("uses an admin-level (<=2) location with a reasonable name directly", async () => {
    const findMany = vi.fn();
    const prisma = { locations: { findMany } };
    const loc = {
      id: "a1",
      name: "Khartoum",
      level: 1,
      population: 1_000_000n,
      ancestorIds: ["a0"],
    };
    expect(await resolveEmailLocation(prisma as never, loc)).toEqual({
      id: "a1",
      name: "Khartoum",
      population: 1_000_000n,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("walks up to the most specific admin ancestor (A2 > A1 > A0) for a deep-level location", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "a0", name: "Sudan", level: 0, population: 40_000_000n },
      { id: "a2", name: "District", level: 2, population: 50_000n },
      { id: "a1", name: "State", level: 1, population: 2_000_000n },
    ]);
    const prisma = { locations: { findMany } };
    const loc = {
      id: "p1",
      name: "raw signal point",
      level: 5,
      population: null,
      ancestorIds: ["a0", "a1", "a2"],
    };
    expect(await resolveEmailLocation(prisma as never, loc)).toEqual({
      id: "a2",
      name: "District",
      population: 50_000n,
    });
  });

  it("treats a garbage (>80 char) name on an admin level as needing a fallback", async () => {
    const longName = "x".repeat(81);
    const findMany = vi.fn().mockResolvedValue([
      { id: "a0", name: "Sudan", level: 0, population: 40_000_000n },
    ]);
    const prisma = { locations: { findMany } };
    const loc = {
      id: "p1",
      name: longName,
      level: 1, // admin level, but the name is garbage
      population: null,
      ancestorIds: ["a0"],
    };
    expect(await resolveEmailLocation(prisma as never, loc)).toEqual({
      id: "a0",
      name: "Sudan",
      population: 40_000_000n,
    });
  });

  it("returns null when a deep location has no ancestors to climb to", async () => {
    const findMany = vi.fn();
    const prisma = { locations: { findMany } };
    const loc = {
      id: "p1",
      name: "raw point",
      level: 7,
      population: null,
      ancestorIds: [],
    };
    expect(await resolveEmailLocation(prisma as never, loc)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns null when no ancestor is an admin level (0-2)", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "p2", name: "another point", level: 4, population: null },
    ]);
    const prisma = { locations: { findMany } };
    const loc = {
      id: "p1",
      name: "raw point",
      level: 6,
      population: null,
      ancestorIds: ["p2"],
    };
    expect(await resolveEmailLocation(prisma as never, loc)).toBeNull();
  });
});

describe("fetchEventSignalLocations", () => {
  /** Build a signalEvents link with the given per-signal location slots. */
  function link(loc: {
    generalLocation?: unknown;
    originLocation?: unknown;
    destinationLocation?: unknown;
  }) {
    return {
      signal: {
        generalLocation: loc.generalLocation ?? null,
        originLocation: loc.originLocation ?? null,
        destinationLocation: loc.destinationLocation ?? null,
      },
    };
  }

  it("uses an admin-level (<=2) signal location directly and skips the ancestor lookup", async () => {
    const signalFindMany = vi.fn().mockResolvedValue([
      link({
        generalLocation: {
          id: "g1",
          name: "Khartoum",
          level: 1,
          pointType: null,
          ancestorIds: ["a0"],
        },
      }),
    ]);
    const locFindMany = vi.fn();
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: locFindMany },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out).toEqual({ ids: ["g1"], names: ["Khartoum"], overflow: 0 });
    // No deep/non-landmark rows → no ancestor batch query.
    expect(locFindMany).not.toHaveBeenCalled();
  });

  it("prefers general > origin > destination per signal", async () => {
    const signalFindMany = vi.fn().mockResolvedValue([
      link({
        originLocation: {
          id: "o1",
          name: "Origin",
          level: 2,
          pointType: null,
          ancestorIds: [],
        },
        destinationLocation: {
          id: "d1",
          name: "Dest",
          level: 2,
          pointType: null,
          ancestorIds: [],
        },
      }),
    ]);
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: vi.fn() },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    // generalLocation is null → falls to origin (not destination).
    expect(out.names).toEqual(["Origin"]);
    expect(out.ids).toEqual(["o1"]);
  });

  it("uses a landmark-geocoded location directly even at a deep level", async () => {
    const signalFindMany = vi.fn().mockResolvedValue([
      link({
        generalLocation: {
          id: "lm1",
          name: "Airport",
          level: 4,
          pointType: "landmark-geocoded",
          ancestorIds: ["a0"],
        },
      }),
    ]);
    const locFindMany = vi.fn();
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: locFindMany },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out.names).toEqual(["Airport"]);
    expect(locFindMany).not.toHaveBeenCalled();
  });

  it("resolves a deep non-landmark point to its most-specific admin ancestor", async () => {
    const signalFindMany = vi.fn().mockResolvedValue([
      link({
        generalLocation: {
          id: "p1",
          name: "raw signal text",
          level: 6,
          pointType: null,
          ancestorIds: ["a0", "a2"],
        },
      }),
    ]);
    const locFindMany = vi.fn().mockResolvedValue([
      { id: "a0", name: "Sudan", level: 0 },
      { id: "a2", name: "District", level: 2 },
    ]);
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: locFindMany },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out).toEqual({ ids: ["a2"], names: ["District"], overflow: 0 });
    // Ancestor batch lookup should have been deduped to the needed ids.
    const whereIds = locFindMany.mock.calls[0][0].where.id.in as string[];
    expect([...whereIds].sort()).toEqual(["a0", "a2"]);
  });

  it("dedupes by resolved id, not by name", async () => {
    // Two distinct admin locations that happen to share a display name must
    // both survive; two signals resolving to the SAME id collapse to one.
    const signalFindMany = vi.fn().mockResolvedValue([
      link({
        generalLocation: { id: "x", name: "Same", level: 1, pointType: null, ancestorIds: [] },
      }),
      link({
        generalLocation: { id: "x", name: "Same", level: 1, pointType: null, ancestorIds: [] },
      }),
      link({
        generalLocation: { id: "y", name: "Same", level: 1, pointType: null, ancestorIds: [] },
      }),
    ]);
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: vi.fn() },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out.ids).toEqual(["x", "y"]);
    expect(out.names).toEqual(["Same", "Same"]);
    expect(out.overflow).toBe(0);
  });

  it("caps at 3 names and reports the overflow count", async () => {
    const links = ["a", "b", "c", "d", "e"].map((id) =>
      link({
        generalLocation: { id, name: id.toUpperCase(), level: 1, pointType: null, ancestorIds: [] },
      }),
    );
    const signalFindMany = vi.fn().mockResolvedValue(links);
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: vi.fn() },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out.names).toEqual(["A", "B", "C"]);
    expect(out.ids).toEqual(["a", "b", "c"]);
    expect(out.overflow).toBe(2);
  });

  it("skips signals with no location at all", async () => {
    const signalFindMany = vi.fn().mockResolvedValue([
      link({}),
      link({
        generalLocation: { id: "g1", name: "Real", level: 1, pointType: null, ancestorIds: [] },
      }),
    ]);
    const prisma = {
      signalEvents: { findMany: signalFindMany },
      locations: { findMany: vi.fn() },
    };
    const out = await fetchEventSignalLocations(prisma as never, "evt1");
    expect(out.names).toEqual(["Real"]);
  });
});

describe("localizeLocationNames", () => {
  it("returns an empty map without querying when there are no ids", async () => {
    const findMany = vi.fn();
    const prisma = { translations: { findMany } };
    const out = await localizeLocationNames(prisma as never, [], ["fr"]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns an empty map without querying when the only locale is en", async () => {
    const findMany = vi.fn();
    const prisma = { translations: { findMany } };
    const out = await localizeLocationNames(prisma as never, ["loc1"], ["en"]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("builds a nested id -> locale -> name map and excludes en from the query", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { entityId: "loc1", locale: "fr", data: { name: "Khartoum-FR" } },
      { entityId: "loc1", locale: "ar", data: { name: "Khartoum-AR" } },
      { entityId: "loc2", locale: "fr", data: { name: "State-FR" } },
    ]);
    const prisma = { translations: { findMany } };
    const out = await localizeLocationNames(
      prisma as never,
      ["loc1", "loc2", "loc1"], // dup id
      ["en", "fr", "ar"],
    );

    const whereLocales = findMany.mock.calls[0][0].where.locale.in as string[];
    expect([...whereLocales].sort()).toEqual(["ar", "fr"]); // en excluded
    const whereIds = findMany.mock.calls[0][0].where.entityId.in as string[];
    expect([...whereIds].sort()).toEqual(["loc1", "loc2"]); // deduped

    expect(out.get("loc1")?.get("fr")).toBe("Khartoum-FR");
    expect(out.get("loc1")?.get("ar")).toBe("Khartoum-AR");
    expect(out.get("loc2")?.get("fr")).toBe("State-FR");
  });

  it("skips rows whose data carries no string name", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { entityId: "loc1", locale: "fr", data: {} },
      { entityId: "loc2", locale: "fr", data: { name: 42 } },
      { entityId: "loc3", locale: "fr", data: null },
    ]);
    const prisma = { translations: { findMany } };
    const out = await localizeLocationNames(
      prisma as never,
      ["loc1", "loc2", "loc3"],
      ["fr"],
    );
    expect(out.size).toBe(0);
  });
});

describe("resolveEventTypeLabel", () => {
  it("returns null for an empty types array", async () => {
    const findFirst = vi.fn();
    const prisma = { disasterTypes: { findFirst } };
    expect(await resolveEventTypeLabel(prisma as never, [])).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns the level1 label from a case-insensitive glideNumber match", async () => {
    const findFirst = vi.fn().mockResolvedValue({ level1: "Flood" });
    const prisma = { disasterTypes: { findFirst } };
    expect(await resolveEventTypeLabel(prisma as never, ["FL", "EQ"])).toBe("Flood");
    // Only the first code is looked up, case-insensitively.
    expect(findFirst).toHaveBeenCalledWith({
      where: { glideNumber: { equals: "FL", mode: "insensitive" } },
      select: { level1: true },
    });
  });

  it("falls back to the raw code when no disaster type matches", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { disasterTypes: { findFirst } };
    expect(await resolveEventTypeLabel(prisma as never, ["XX"])).toBe("XX");
  });
});
