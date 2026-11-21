/**
 * The `data_sources` rows `createManualSignal` requires (clear #1568).
 *
 * The mutation accepts exactly `TRUSTED_SOURCE_NAMES` and rejects every other
 * source name, so each of those names needs a row for an analyst to file a
 * signal from it. Only `field_officer` was ever created by code, and only by
 * `prisma/seed.ts`, which runs on local databases alone.
 *
 * Why a test rather than a startup assertion — the opposite choice to clear
 * #1523's deploy-time check, for a reason: there, the rows live in clear-api
 * and the code in clear-pipeline, so only a check against the live environment
 * can know. Here clear-api owns both, and a migration is the only thing that
 * creates them, so "every migration applied" implies "every row exists". The
 * CI db-tests job runs against a database migrated from empty, which makes the
 * first test below a proof of that implication rather than a sample of it — and
 * it fails on the pull request instead of taking the whole API down at boot
 * over a problem that only affects filing a manual signal.
 *
 * Self-seeding: creates nothing, and restores anything it removes.
 *   bun run test:db tests/db/trusted-manual-data-sources.db.test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { TRUSTED_SOURCE_NAMES } from "../../src/resolvers/signal.resolver.js";
import { describeIfDb, describeIfScratchDb } from "../helpers/db.js";

const MIGRATION_DIR = "20261121140000_ensure_trusted_manual_data_sources";
const MIGRATION = readFileSync(
  fileURLToPath(new URL(`../../prisma/migrations/${MIGRATION_DIR}/migration.sql`, import.meta.url)),
  "utf8",
);

const TRUSTED = [...TRUSTED_SOURCE_NAMES];

// Runs in the DB-free suite too: the cheapest possible guard against adding a
// name to TRUSTED_SOURCE_NAMES and not to the migration, and the one that fires
// first. The DB tests below prove the migration actually works; this one only
// proves the two lists agree.
it("the migration names every trusted source", () => {
  for (const name of TRUSTED) {
    expect(MIGRATION).toContain(`('${name}')`);
  }
});

const rows = () =>
  prisma.dataSources.findMany({
    where: { name: { in: TRUSTED } },
    select: { id: true, name: true, type: true, isActive: true, updatedAt: true },
    orderBy: { name: "asc" },
  });

describeIfDb("trusted manual data sources", () => {
  it("exist in a database migrated from empty", async () => {
    const found = await rows();
    expect(found.map((r) => r.name).sort()).toEqual([...TRUSTED].sort());
    for (const row of found) {
      expect(row.type).toBe("manual");
      expect(row.isActive).toBe(true);
    }
  });

  it("re-running the migration changes nothing", async () => {
    const before = await rows();
    await prisma.$executeRawUnsafe(MIGRATION);
    expect(await rows()).toEqual(before);
  });

});

// Scratch database only: this one deletes a row to watch the migration put it
// back, and on any real database that row is not ours to delete. It would also
// simply fail there -- `prisma/seed.ts` creates `field_officer` with a cuid id,
// so deleting by id finds nothing, and where the id does match, signals
// referencing it block the delete (RESTRICT). A test that passes in CI and
// fails on a developer's database is a test nobody trusts.
describeIfScratchDb("the migration's WHERE NOT EXISTS branch", () => {
  afterAll(async () => {
    // If an assertion below threw between the delete and the re-run, put the
    // row back rather than leaving even the scratch database short.
    await prisma.$executeRawUnsafe(MIGRATION);
  });

  it("recreates a missing row, and only that one", async () => {
    const [missing, ...kept] = TRUSTED;
    const keptBefore = (await rows()).filter((r) => r.name !== missing);

    // By name, not id: the row's id is the name only when this migration
    // created it, which is true on a scratch database and nowhere else.
    await prisma.dataSources.deleteMany({ where: { name: missing } });
    expect((await rows()).map((r) => r.name)).not.toContain(missing);

    await prisma.$executeRawUnsafe(MIGRATION);

    const after = await rows();
    expect(after.map((r) => r.name)).toContain(missing);
    expect(after.find((r) => r.name === missing)).toMatchObject({ type: "manual", isActive: true });
    // The rows that were already there keep their id and updatedAt — the point
    // of `WHERE NOT EXISTS`, and what makes this safe to apply to prod, where
    // `partner` was inserted by hand with a cuid id.
    expect(after.filter((r) => r.name !== missing)).toEqual(keptBefore);
    expect(kept.length).toBeGreaterThan(0);
  });
});
