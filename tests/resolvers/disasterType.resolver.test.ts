/**
 * Unit tests for `disasterType.resolver.ts`.
 *
 * DB-free: `context.prisma.disasterTypes.findMany` is stubbed per-test.
 * The simple `disasterTypes` / `disasterType` queries are thin passthroughs;
 * the logic worth covering lives in `disasterTypeHierarchy`, which:
 *   1. Groups rows into level1 → level2 → [rows].
 *   2. Falls back level1 → disasterClass → "other" and
 *      level2 → disasterType → "other" when fields are blank.
 *   3. De-duplicates glideNumber into each group's `codes`.
 *   4. Requests rows ordered by level1, level2, disasterType.
 */

import { describe, it, expect, vi } from "vitest";
import { disasterTypeResolvers } from "../../src/resolvers/disasterType.resolver.js";
import type { Context } from "../../src/context.js";

function buildContext(rows: unknown[]): { ctx: Context; findMany: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockResolvedValue(rows);
  const ctx = {
    prisma: { disasterTypes: { findMany } } as unknown as Context["prisma"],
    user: null,
    session: null,
    authMethod: null,
  } as Context;
  return { ctx, findMany };
}

const { disasterTypeHierarchy } = disasterTypeResolvers.Query;

function row(over: Partial<Record<string, string>> = {}) {
  return {
    id: "1",
    disasterType: "Flood",
    disasterClass: "Hydrological",
    glideNumber: "FL",
    level1: "Natural",
    level2: "Geophysical",
    idType: "x",
    ...over,
  };
}

describe("Query.disasterTypeHierarchy", () => {
  it("orders the underlying query by level1, level2, disasterType", async () => {
    const { ctx, findMany } = buildContext([]);
    await disasterTypeHierarchy(null, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ level1: "asc" }, { level2: "asc" }, { disasterType: "asc" }],
    });
  });

  it("returns an empty array when there are no rows", async () => {
    const { ctx } = buildContext([]);
    expect(await disasterTypeHierarchy(null, {}, ctx)).toEqual([]);
  });

  it("nests level1 → level2 → subTypes and dedupes codes", async () => {
    const r1 = row({ id: "1", level2: "Geophysical", glideNumber: "EQ" });
    const r2 = row({ id: "2", level2: "Geophysical", glideNumber: "EQ" }); // dup code
    const r3 = row({ id: "3", level2: "Meteorological", glideNumber: "ST" });
    const { ctx } = buildContext([r1, r2, r3]);

    const result = await disasterTypeHierarchy(null, {}, ctx);

    expect(result).toHaveLength(1);
    const l1 = result[0];
    expect(l1.name).toBe("Natural");
    expect(l1.groups).toHaveLength(2);

    const geo = l1.groups.find((g: { name: string }) => g.name === "Geophysical");
    expect(geo.subTypes).toHaveLength(2);
    expect(geo.codes).toEqual(["EQ"]); // de-duplicated

    const meteo = l1.groups.find((g: { name: string }) => g.name === "Meteorological");
    expect(meteo.codes).toEqual(["ST"]);
  });

  it("splits rows across two distinct level1 groups", async () => {
    const { ctx } = buildContext([
      row({ id: "1", level1: "Natural" }),
      row({ id: "2", level1: "Technological" }),
    ]);
    const result = await disasterTypeHierarchy(null, {}, ctx);
    expect(result.map((g: { name: string }) => g.name).sort()).toEqual(["Natural", "Technological"]);
  });

  it("falls back to disasterClass / disasterType, then 'other', when level fields are blank", async () => {
    const { ctx } = buildContext([
      row({ level1: "", level2: "", disasterClass: "Hydrological", disasterType: "Flood" }),
    ]);
    const result = await disasterTypeHierarchy(null, {}, ctx);
    expect(result[0].name).toBe("Hydrological"); // level1 -> disasterClass
    expect(result[0].groups[0].name).toBe("Flood"); // level2 -> disasterType
  });

  it("falls back all the way to 'other' when every grouping field is blank", async () => {
    const { ctx } = buildContext([
      row({ level1: "", level2: "", disasterClass: "", disasterType: "" }),
    ]);
    const result = await disasterTypeHierarchy(null, {}, ctx);
    expect(result[0].name).toBe("other");
    expect(result[0].groups[0].name).toBe("other");
  });
});
