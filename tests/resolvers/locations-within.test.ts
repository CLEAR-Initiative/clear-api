/**
 * `Query.locations(level, within)` — scoping a level to part of the hierarchy.
 *
 * `locationsWhere` is pure and always runs. The DB suite seeds its own
 * country → two states → districts and deletes them in `afterAll`, so it runs
 * against a scratch database (`bun run test:db`) as well as a dev one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { locationResolvers, locationsWhere } from "../../src/resolvers/location.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

describe("locationsWhere", () => {
  it("is empty without arguments", () => {
    expect(locationsWhere({})).toEqual({});
    expect(locationsWhere({ level: null, within: null })).toEqual({});
  });

  it("filters by level", () => {
    expect(locationsWhere({ level: 2 })).toEqual({ level: 2 });
    expect(locationsWhere({ level: 0 })).toEqual({ level: 0 });
  });

  it("scopes to the given locations and their descendants", () => {
    expect(locationsWhere({ level: 2, within: ["a", "b"] })).toEqual({
      level: 2,
      OR: [{ id: { in: ["a", "b"] } }, { ancestorIds: { hasSome: ["a", "b"] } }],
    });
  });

  it("treats an empty scope as no scope", () => {
    expect(locationsWhere({ level: 1, within: [] })).toEqual({ level: 1 });
  });
});

describeIfDb("Query.locations within (DB)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = (name: string) => `__test_within_${name}_${stamp}`;
  const COUNTRY = id("country");
  const STATE_A = id("state_a");
  const STATE_B = id("state_b");
  const DISTRICT_A1 = id("district_a1");
  const DISTRICT_A2 = id("district_a2");
  const DISTRICT_B1 = id("district_b1");
  const created: string[] = [];

  const ctx = { prisma } as unknown as Context;
  const locations = (args: { level?: number; within?: string[] }) =>
    locationResolvers.Query.locations(undefined, args, ctx);
  const idsOf = (rows: Array<{ id: string }>) =>
    rows.map((r) => r.id).filter((i) => created.includes(i)).sort();

  async function insert(locId: string, level: number, parentId: string | null, ancestorIds: string[]) {
    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${locId}, ${locId}, ${level}, ${parentId}, ${ancestorIds}, ST_SetSRID(ST_MakePoint(30, 15), 4326))
    `;
    created.push(locId);
  }

  beforeAll(async () => {
    await insert(COUNTRY, 0, null, []);
    await insert(STATE_A, 1, COUNTRY, [COUNTRY]);
    await insert(STATE_B, 1, COUNTRY, [COUNTRY]);
    await insert(DISTRICT_A1, 2, STATE_A, [COUNTRY, STATE_A]);
    await insert(DISTRICT_A2, 2, STATE_A, [COUNTRY, STATE_A]);
    await insert(DISTRICT_B1, 2, STATE_B, [COUNTRY, STATE_B]);
  });

  afterAll(async () => {
    await prisma.locations.deleteMany({ where: { id: { in: created } } });
  });

  it("returns only one state's districts", async () => {
    expect(idsOf(await locations({ level: 2, within: [STATE_A] }))).toEqual(
      [DISTRICT_A1, DISTRICT_A2].sort(),
    );
  });

  it("returns a country's states", async () => {
    expect(idsOf(await locations({ level: 1, within: [COUNTRY] }))).toEqual(
      [STATE_A, STATE_B].sort(),
    );
  });

  it("includes the scope location itself at its own level", async () => {
    expect(idsOf(await locations({ level: 0, within: [COUNTRY] }))).toEqual([COUNTRY]);
  });

  it("unions several scopes", async () => {
    expect(idsOf(await locations({ level: 2, within: [STATE_A, STATE_B] }))).toEqual(
      [DISTRICT_A1, DISTRICT_A2, DISTRICT_B1].sort(),
    );
  });

  it("is unchanged without within", async () => {
    expect(idsOf(await locations({ level: 2 }))).toEqual(
      [DISTRICT_A1, DISTRICT_A2, DISTRICT_B1].sort(),
    );
  });
});
