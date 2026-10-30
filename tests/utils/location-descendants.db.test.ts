/**
 * `getLocationIdsWithDescendants` backs the location filter on every
 * signals/events/alerts list query. It must return the location plus its
 * whole subtree, and it must stay answerable from the GIN index on
 * `ancestor_ids`: the old `$1 = ANY("ancestor_ids")` form scanned the whole
 * locations table on every request (ticket #1234).
 *
 * Self-seeding: creates a four-row tree and deletes it in afterAll.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  getLocationIdsWithDescendants,
  locationIdsWithDescendantsSql,
} from "../../src/utils/geo-resolve.js";
import { describeIfDb } from "../helpers/db.js";

const suffix = Math.random().toString(36).slice(2, 10);
const root = `desc-root-${suffix}`;
const child = `desc-child-${suffix}`;
const grandchild = `desc-grandchild-${suffix}`;
const unrelated = `desc-other-${suffix}`;
const ids = [root, child, grandchild, unrelated];

async function insert(id: string, level: number, parentId: string | null, ancestorIds: string[]) {
  await prisma.$executeRaw`
    INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${id}, ${level}, ${parentId}, ${ancestorIds}::text[], ST_GeomFromText('POINT(0 0)', 4326))
  `;
}

describeIfDb("getLocationIdsWithDescendants", () => {
  beforeAll(async () => {
    await insert(root, 0, null, []);
    await insert(child, 1, root, [root]);
    await insert(grandchild, 2, child, [child, root]);
    await insert(unrelated, 0, null, []);
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${ids}::text[])`;
    await prisma.$disconnect();
  });

  it("returns the location and its whole subtree, nothing else", async () => {
    expect((await getLocationIdsWithDescendants(prisma, root)).sort()).toEqual([child, grandchild, root].sort());
    expect((await getLocationIdsWithDescendants(prisma, child)).sort()).toEqual([child, grandchild].sort());
    expect(await getLocationIdsWithDescendants(prisma, grandchild)).toEqual([grandchild]);
  });

  it("can be answered from the ancestor_ids GIN index", async () => {
    // With sequential scans priced out, the planner picks the GIN index if
    // the predicate can use it at all; `= ANY(...)` falls back to a seq scan.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRaw<{ "QUERY PLAN": string }[]>(
        Prisma.sql`EXPLAIN ${locationIdsWithDescendantsSql(root)}`,
      );
    });
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("locations_ancestor_ids_idx");
  });
});
