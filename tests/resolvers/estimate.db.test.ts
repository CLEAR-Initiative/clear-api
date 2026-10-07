/**
 * Integration tests for Estimates against the real, migrated schema
 * (CLEAR Domain Ontology v0.3.0).
 *
 * The DB-free suite stubs Prisma, so it can't see the rules that live only in
 * the migration: the bounds CHECK, the `estimates_immutable` trigger, one
 * supersession per Estimate, the Event cascade, and the one-off backfill from
 * the Event scalars. The backfill already ran (on an empty table) when the
 * scratch database was migrated, so its statement is read back out of the
 * migration file and replayed inside a transaction that is rolled back —
 * other suites' Events never see it.
 *
 * Self-seeding: every row hangs off fresh Events, deleted in afterAll (the
 * Event cascade takes the Estimates), so this runs against an empty scratch
 * database: `bun run test:db tests/resolvers/estimate.db.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { estimateResolvers } from "../../src/resolvers/estimate.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `estimate-db-${Date.now()}`;
const VIEWER: Context = {
  prisma,
  user: { id: `${RUN}-viewer`, role: "viewer" },
  session: null,
  authMethod: "session",
} as unknown as Context;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations/20261007163642_add_estimates/migration.sql",
);
/** The backfill statement, exactly as the migration ran it. */
const BACKFILL_SQL = (() => {
  const sql = readFileSync(MIGRATION, "utf-8");
  return sql.slice(sql.indexOf('INSERT INTO "estimates"'));
})();

const eventIds: string[] = [];
const AT = new Date("2026-09-15T12:00:00Z");

async function createEvent(data: { populationAffected?: bigint; populationDisplaced?: bigint; casualties?: number } = {}) {
  const row = await prisma.events.create({
    data: {
      types: ["FL"],
      validTo: AT,
      firstSignalCreatedAt: new Date("2026-09-10T00:00:00Z"),
      lastSignalCreatedAt: AT,
      rank: 0,
      ...data,
    },
  });
  eventIds.push(row.id);
  return row.id;
}

function figure(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId,
    metric: "people_affected" as const,
    value: 1000,
    unit: "people",
    method: "media_report" as const,
    attribution: "event_caused" as const,
    validFor: AT,
    estimatedAt: new Date(),
    definitionVersion: "0.3.0",
    ...overrides,
  };
}

/** The Postgres error a raw statement or Prisma write was refused with. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected the write to be refused");
}

class Rollback extends Error {}

describeIfDb("Estimates against the real schema", () => {
  let eventId: string;

  beforeAll(async () => {
    eventId = await createEvent();
  });

  afterAll(async () => {
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
  });

  it("accepts a figure inside its bounds, and one bound on its own", async () => {
    const a = await prisma.estimate.create({ data: figure(eventId, { lowerBound: 800, upperBound: 1500 }) });
    const b = await prisma.estimate.create({ data: figure(eventId, { lowerBound: 1000 }) });
    expect(a.isGroundTruth).toBe(false);
    expect(b.upperBound).toBeNull();
  });

  it("refuses lowerBound > value and value > upperBound", async () => {
    expect(await refusal(prisma.estimate.create({ data: figure(eventId, { lowerBound: 1001 }) }))).toMatch(
      /estimates_bounds_check/,
    );
    expect(await refusal(prisma.estimate.create({ data: figure(eventId, { upperBound: 999 }) }))).toMatch(
      /estimates_bounds_check/,
    );
  });

  it("requires an attribution", async () => {
    const msg = await refusal(
      prisma.$executeRawUnsafe(
        `INSERT INTO estimates (id, event_id, metric, value, method, valid_for, estimated_at, definition_version)
         VALUES ($1, $2, 'people_affected', 1, 'media_report', now(), now(), '0.3.0')`,
        `${RUN}-no-attribution`,
        eventId,
      ),
    );
    expect(msg).toMatch(/attribution/);
  });

  it("never overwrites an Estimate: an UPDATE of any figure column is refused", async () => {
    const row = await prisma.estimate.create({ data: figure(eventId) });
    for (const data of [{ value: 2000 }, { method: "government_figure" as const }, { isGroundTruth: true }]) {
      expect(await refusal(prisma.estimate.update({ where: { id: row.id }, data }))).toMatch(/never overwritten/);
    }
    expect((await prisma.estimate.findUniqueOrThrow({ where: { id: row.id } })).value).toBe(1000);
  });

  it("corrects by superseding: a new row points at the old one, at most once", async () => {
    const first = await prisma.estimate.create({ data: figure(eventId, { metric: "people_displaced_new", value: 300 }) });
    const second = await prisma.estimate.create({
      data: figure(eventId, { metric: "people_displaced_new", value: 450, supersedesId: first.id }),
    });
    // A second correction of the same Estimate would fork the history.
    expect(
      await refusal(
        prisma.estimate.create({ data: figure(eventId, { metric: "people_displaced_new", supersedesId: first.id }) }),
      ),
    ).toMatch(/Unique constraint|supersedes_id/);
    // Re-pointing an existing row is an overwrite too.
    const other = await prisma.estimate.create({ data: figure(eventId, { metric: "people_displaced_new" }) });
    expect(await refusal(prisma.estimate.update({ where: { id: other.id }, data: { supersedesId: second.id } }))).toMatch(
      /never overwritten/,
    );

    const history = await estimateResolvers.Event.estimates({ id: eventId }, { metric: "people_displaced_new" }, VIEWER);
    expect(history.map((e) => e.id)).toEqual(expect.arrayContaining([first.id, second.id, other.id]));
    const current = await estimateResolvers.Event.estimates(
      { id: eventId },
      { metric: "people_displaced_new", current: true },
      VIEWER,
    );
    expect(current.map((e) => e.id).sort()).toEqual([second.id, other.id].sort());

    const corrected = await estimateResolvers.Estimate.supersededBy(first, {}, VIEWER);
    expect(corrected?.id).toBe(second.id);
    expect((await estimateResolvers.Estimate.supersedes(second, {}, VIEWER))?.id).toBe(first.id);
  });

  it("never clears a link by hand: supersedes, source Signal and creator stay put", async () => {
    const source = await prisma.dataSources.create({ data: { name: `${RUN}-source-2`, type: "test" } });
    const signal = await prisma.signals.create({ data: { sourceId: source.id, rawData: {}, publishedAt: AT } });
    const first = await prisma.estimate.create({ data: figure(eventId, { metric: "people_in_need" }) });
    const second = await prisma.estimate.create({
      data: figure(eventId, { metric: "people_in_need", supersedesId: first.id, sourceSignalId: signal.id }),
    });
    // Clearing supersedes_id would make the corrected figure current again.
    for (const data of [{ supersedesId: null }, { sourceSignalId: null }]) {
      expect(await refusal(prisma.estimate.update({ where: { id: second.id }, data }))).toMatch(/never overwritten/);
    }
    const after = await prisma.estimate.findUniqueOrThrow({ where: { id: second.id } });
    expect(after).toMatchObject({ supersedesId: first.id, sourceSignalId: signal.id });
    // A superseded Estimate can't be deleted out from under its correction.
    expect(await refusal(prisma.estimate.delete({ where: { id: first.id } }))).toMatch(/supersedes_id_fkey|Foreign key/);
    await prisma.estimate.deleteMany({ where: { id: { in: [second.id, first.id] } } });
    await prisma.signals.delete({ where: { id: signal.id } });
    await prisma.dataSources.delete({ where: { id: source.id } });
  });

  it("supersedes only the same figure: same Event, metric and population group", async () => {
    const elsewhere = await createEvent();
    const base = await prisma.estimate.create({ data: figure(eventId, { metric: "people_reached", populationGroup: "IDP" }) });
    const crossings = [
      figure(elsewhere, { metric: "people_reached", populationGroup: "IDP" }),
      figure(eventId, { metric: "people_targeted", populationGroup: "IDP" }),
      figure(eventId, { metric: "people_reached", populationGroup: "refugee" }),
      figure(eventId, { metric: "people_reached" }),
    ];
    for (const data of crossings) {
      expect(await refusal(prisma.estimate.create({ data: { ...data, supersedesId: base.id } }))).toMatch(
        /same event, metric and population group/,
      );
    }
    expect(
      await refusal(prisma.estimate.create({ data: figure(eventId, { supersedesId: `${RUN}-missing` }) })),
    ).toMatch(/does not exist|Foreign key constraint/);
    const ok = await prisma.estimate.create({
      data: figure(eventId, { metric: "people_reached", populationGroup: "IDP", supersedesId: base.id, value: 1500 }),
    });
    expect(ok.supersedesId).toBe(base.id);
  });

  it("lets ON DELETE SET NULL through the trigger: deleting the source Signal keeps the figure", async () => {
    const source = await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } });
    const signal = await prisma.signals.create({
      data: { sourceId: source.id, rawData: {}, publishedAt: AT },
    });
    const row = await prisma.estimate.create({ data: figure(eventId, { sourceSignalId: signal.id }) });
    await prisma.signals.delete({ where: { id: signal.id } });
    await prisma.dataSources.delete({ where: { id: source.id } });
    const after = await prisma.estimate.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.sourceSignalId).toBeNull();
    expect(after.value).toBe(1000);
  });

  it("goes with its Event: deleteEvent keeps working for Events with figures", async () => {
    const doomed = await createEvent();
    const a = await prisma.estimate.create({ data: figure(doomed) });
    await prisma.estimate.create({ data: figure(doomed, { supersedesId: a.id, value: 1100 }) });
    await prisma.events.delete({ where: { id: doomed } });
    expect(await prisma.estimate.count({ where: { eventId: doomed } })).toBe(0);
  });

  it("backfills populationAffected and populationDisplaced, skipping casualties and the pipeline's placeholders", async () => {
    const full = await createEvent({ populationAffected: 12000n, populationDisplaced: 3400n, casualties: 7 });
    const placeholders = await createEvent({ populationAffected: 33000n, populationDisplaced: 1670n, casualties: 2 });
    const empty = await createEvent();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(BACKFILL_SQL);
        // Deterministic ids: a replay inserts nothing.
        expect(await tx.$executeRawUnsafe(BACKFILL_SQL)).toBe(0);

        const rows = await tx.estimate.findMany({
          where: { eventId: { in: [full, placeholders, empty] } },
          orderBy: { metric: "asc" },
        });
        expect(rows.map((r) => [r.eventId, r.metric, r.value])).toEqual([
          [full, "people_affected", 12000],
          [full, "people_displaced_new", 3400],
        ]);
        for (const r of rows) {
          expect(r).toMatchObject({
            unit: "people",
            method: "not_documented",
            attribution: "event_caused",
            isGroundTruth: false,
            definitionVersion: "0.3.0",
            lowerBound: null,
            upperBound: null,
            supersedesId: null,
            createdById: null,
          });
          expect(r.validFor).toEqual(AT);
        }
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(await prisma.estimate.count({ where: { eventId: full } })).toBe(0);
  });
});
