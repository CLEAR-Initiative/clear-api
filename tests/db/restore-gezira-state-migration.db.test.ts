/**
 * The data-fix migration `20261110210000_restore_sudan_gezira_state` against
 * the real, migrated schema. It seeds the broken tree dev had (ticket #1413):
 * Sudan, no SD15 state, SD15 districts with no parent and a dead ancestor id.
 *
 * Self-seeding; every row is deleted in afterAll:
 * `bun run test:db tests/db/restore-gezira-state-migration.db.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { describeIfDb } from "../helpers/db.js";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../../prisma/migrations/20261110210000_restore_sudan_gezira_state/migration.sql", import.meta.url),
  ),
  "utf8",
);

const SUDAN = "gezira-mig-sudan";
const DEAD_STATE = "gezira-mig-dead-state";
const OTHER_STATE = "gezira-mig-sennar";
const D1 = "gezira-mig-medani";
const D2 = "gezira-mig-kamlin";
const OTHER_DISTRICT = "gezira-mig-sinja";
const OLD_POINT = "gezira-mig-old-point";
const NEW_POINT = "gezira-mig-new-point";
const IDS = [NEW_POINT, OLD_POINT, OTHER_DISTRICT, D1, D2, OTHER_STATE, DEAD_STATE, SUDAN];

const square = (x: number, y: number) =>
  `MULTIPOLYGON(((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y})))`;

async function insert(row: {
  id: string;
  pCode: string | null;
  name: string;
  level: number;
  parentId: string | null;
  ancestorIds: string[];
  wkt: string;
  population?: number;
}) {
  await prisma.$executeRaw`
    INSERT INTO "locations" ("id", "p_code", "name", "level", "parent_id", "ancestor_ids", "geometry", "population")
    VALUES (${row.id}, ${row.pCode}, ${row.name}, ${row.level}, ${row.parentId}, ${row.ancestorIds},
            ST_GeomFromText(${row.wkt}, 4326), ${row.population ?? null}::bigint)
  `;
}

const runMigration = () => prisma.$executeRawUnsafe(MIGRATION);

const row = (id: string) =>
  prisma.locations.findUnique({
    where: { id },
    select: { id: true, name: true, pCode: true, level: true, parentId: true, ancestorIds: true, population: true },
  });

async function cleanUp() {
  await prisma.$executeRaw`DELETE FROM "locations" WHERE "p_code" = 'SD15' AND "parent_id" = ${SUDAN}`;
  for (const id of IDS) await prisma.$executeRaw`DELETE FROM "locations" WHERE "id" = ${id}`;
}

describeIfDb("migration: restore Sudan's Gezira state", () => {
  beforeAll(async () => {
    await cleanUp();
    await insert({ id: SUDAN, pCode: "SD", name: "Sudan", level: 0, parentId: null, ancestorIds: [], wkt: square(30, 10) });
    await insert({
      id: OTHER_STATE, pCode: "SD14", name: "Sennar", level: 1, parentId: SUDAN, ancestorIds: [SUDAN], wkt: square(40, 10),
    });
    await insert({
      id: OTHER_DISTRICT, pCode: "SD14001", name: "Sinja", level: 2, parentId: OTHER_STATE,
      ancestorIds: [OTHER_STATE, SUDAN], wkt: square(40, 10),
    });
    // The two orphans: no parent, and an ancestor id that no longer exists.
    await insert({
      id: D1, pCode: "SD15030", name: "Medani Al Kubra", level: 2, parentId: null,
      ancestorIds: [DEAD_STATE, SUDAN], wkt: square(33, 14), population: 100,
    });
    await insert({
      id: D2, pCode: "SD15035", name: "Al Kamlin", level: 2, parentId: null,
      ancestorIds: [DEAD_STATE, SUDAN], wkt: square(34, 14), population: 50,
    });
    // A point from before the delete, and one created after it.
    await insert({
      id: OLD_POINT, pCode: null, name: "Wad Madani", level: 4, parentId: D1,
      ancestorIds: [D1, DEAD_STATE, SUDAN], wkt: "POINT(33.5 14.4)",
    });
    await insert({
      id: NEW_POINT, pCode: null, name: "Al Kamlin town", level: 4, parentId: D2,
      ancestorIds: [D2], wkt: "POINT(34.5 14.5)",
    });
    await runMigration();
  });

  afterAll(cleanUp);

  it("creates the state under Sudan with the deleted row's id", async () => {
    expect(await row(DEAD_STATE)).toEqual({
      id: DEAD_STATE, name: "Gezira", pCode: "SD15", level: 1, parentId: SUDAN, ancestorIds: [SUDAN], population: 150n,
    });
  });

  it("gives the state the union of its districts' polygons", async () => {
    const [geo] = await prisma.$queryRaw<{ type: string; area: number; covers: boolean }[]>`
      SELECT GeometryType(s."geometry") AS type, ST_Area(s."geometry")::float8 AS area,
             ST_Covers(s."geometry", (SELECT ST_Union("geometry") FROM "locations" WHERE "id" IN (${D1}, ${D2}))) AS covers
      FROM "locations" s WHERE s."id" = ${DEAD_STATE}
    `;
    expect(geo).toMatchObject({ type: "MULTIPOLYGON", covers: true });
    expect(geo!.area).toBeCloseTo(2, 6);
  });

  it("re-parents the districts and repairs their ancestor chain", async () => {
    for (const id of [D1, D2]) {
      expect(await row(id)).toMatchObject({ parentId: DEAD_STATE, ancestorIds: [DEAD_STATE, SUDAN] });
    }
  });

  it("repairs the ancestor chain of points under the districts", async () => {
    expect((await row(OLD_POINT))!.ancestorIds).toEqual([D1, DEAD_STATE, SUDAN]);
    expect((await row(NEW_POINT))!.ancestorIds).toEqual([D2, DEAD_STATE, SUDAN]);
  });

  it("leaves other states and districts alone", async () => {
    expect(await row(OTHER_STATE)).toMatchObject({ parentId: SUDAN, ancestorIds: [SUDAN] });
    expect(await row(OTHER_DISTRICT)).toMatchObject({ parentId: OTHER_STATE, ancestorIds: [OTHER_STATE, SUDAN] });
  });

  it("changes nothing when it runs again (the state exists, as on prod)", async () => {
    const before = await prisma.locations.count();
    await runMigration();
    expect(await prisma.locations.count()).toBe(before);
    expect(await prisma.locations.count({ where: { pCode: "SD15", level: 1 } })).toBe(1);
  });
});
