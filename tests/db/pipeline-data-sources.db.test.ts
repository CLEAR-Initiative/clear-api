/**
 * The `data_sources` rows clear-pipeline resolves by name (clear #1569).
 *
 * clear-pipeline's ingest resolves each source's id with
 * `get_source_id_by_name`, and a missing row fails that source's job on every
 * run with a green code location above it — the 2026-10-20 `idmc` and
 * 2026-11-13 `iom_dtm_flash_alerts` incidents (clear #1053, #1520). Its own
 * deploy gate now refuses to build an image for an environment that is missing
 * one (`python -m clear_pipeline.checks.data_sources`, clear #1523), but the
 * rows are created here, so this is the end that can prevent the failure rather
 * than report it.
 *
 * The list is a cross-repo contract and therefore a copy, like
 * clear-pipeline's `MANUAL_TRUSTED_SOURCE_NAMES` mirroring this repo's
 * `TRUSTED_SOURCE_NAMES` in the other direction. Keep it in step with
 * `required_source_names()` in
 * `src/clear_pipeline/checks/data_sources.py`.
 *
 * Self-seeding: creates nothing, and restores anything it removes.
 *   bun run test:db tests/db/pipeline-data-sources.db.test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { describeIfDb, describeIfScratchDb } from "../helpers/db.js";

const MIGRATION_DIR = "20261121150000_ensure_inso_data_source";
const MIGRATION = readFileSync(
  fileURLToPath(new URL(`../../prisma/migrations/${MIGRATION_DIR}/migration.sql`, import.meta.url)),
  "utf8",
);

/**
 * Every source name clear-pipeline resolves to a DataSource id: the union of
 * its `CONNECTORS` and `GX_SOURCES` filtered to the ones that declare
 * `api_source_id`. Pinned here so adding a source there without a migration
 * here is caught, and so the reverse — dropping a row — is caught too.
 */
const PIPELINE_REQUIRED = [
  "acled",
  "darfur24",
  "dataminr",
  "gdacs",
  "idmc",
  "inso",
  "iom_dtm_flash_alerts",
  "sudan_witness",
];

/**
 * Deliberately absent, and not an oversight — see
 * 20261121150000_ensure_inso_data_source's comment. `POST /api/x/ingest`
 * resolves the batch's own `source` name against this table, so for this feed
 * the row is close to being the switch; it stays off until its owners say
 * otherwise. clear-pipeline never resolves the name, so its deploy gate does
 * not require it. Changing this means changing a test, which is the point.
 */
const DELIBERATELY_ABSENT = ["sudan-war-x"];

const rows = (names: string[]) =>
  prisma.dataSources.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, type: true, isActive: true, updatedAt: true },
    orderBy: { name: "asc" },
  });

// Runs in the DB-free suite too: the cheapest guard, and the one that fires
// first, against this migration losing the row it exists to create.
it("the migration names inso", () => {
  expect(MIGRATION).toContain("'inso'");
});

describeIfDb("data sources clear-pipeline resolves by name", () => {
  it("all exist in a database migrated from empty", async () => {
    const found = await rows(PIPELINE_REQUIRED);
    expect(found.map((r) => r.name)).toEqual([...PIPELINE_REQUIRED].sort());
    for (const row of found) expect(row.isActive).toBe(true);
  });

  it("leaves sudan-war-x absent", async () => {
    // The asymmetry 20261120160000 was right about, pinned so re-adding the row
    // is a deliberate change in review rather than a side effect.
    expect(await rows(DELIBERATELY_ABSENT)).toEqual([]);
  });

  it("re-running the inso migration changes nothing", async () => {
    const before = await rows(PIPELINE_REQUIRED);
    await prisma.$executeRawUnsafe(MIGRATION);
    expect(await rows(PIPELINE_REQUIRED)).toEqual(before);
  });
});

// Scratch database only: deletes a row to watch the migration put it back. On
// any real database that row is not ours to delete, and dev's `inso` has a cuid
// id with signals behind it. See describeIfScratchDb in tests/helpers/db.ts.
describeIfScratchDb("the inso migration's WHERE NOT EXISTS branch", () => {
  afterAll(async () => {
    await prisma.$executeRawUnsafe(MIGRATION);
  });

  it("recreates inso when it is missing, and only inso", async () => {
    const others = PIPELINE_REQUIRED.filter((n) => n !== "inso");
    const othersBefore = await rows(others);

    await prisma.dataSources.deleteMany({ where: { name: "inso" } });
    expect(await rows(["inso"])).toEqual([]);

    await prisma.$executeRawUnsafe(MIGRATION);

    const inso = await rows(["inso"]);
    expect(inso).toHaveLength(1);
    expect(inso[0]).toMatchObject({ name: "inso", type: "email", isActive: true });
    // Nothing else moved: the other seven keep their id and updatedAt.
    expect(await rows(others)).toEqual(othersBefore);
  });
});
