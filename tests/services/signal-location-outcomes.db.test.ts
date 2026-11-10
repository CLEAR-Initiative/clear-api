/**
 * The Outcome log against the real schema (ADR-0020): which mutations write
 * an Outcome, which kind each one is, and that a replay changes neither the
 * week nor the level of a Signal in location precision. Self-seeding; run
 * with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Context } from "../../src/context.js";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { computeLocationPrecisionMetrics } from "../../src/services/location-precision-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `slo-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const STATE = `${RUN}-state`;
const DISTRICT = `${RUN}-district`;
const SOURCE = `${RUN}-x`;
let sourceId = "";
let n = 0;

// The pipeline integrations authenticate as a system admin through an API key.
const ctx = { prisma, user: { id: "pipeline", role: "admin" }, session: null, authMethod: "apiKey", locale: "en" } as unknown as Context;
const { createSignal, markSignalsProcessed, updateSignalLocation, requeueSignals } = signalResolvers.Mutation;

/** A text-only Signal as a connector creates it: no location, collected at `collectedAt`. */
async function arrive(collectedAt: string, extra: Record<string, unknown> = {}) {
  const signal = await createSignal(
    {},
    { input: { sourceId, externalId: `${RUN}-${n++}`, rawData: {}, publishedAt: collectedAt, collectedAt, ...extra } as never },
    ctx,
  );
  return signal.id;
}

const outcomes = (signalId: string) =>
  prisma.signalLocationOutcomes.findMany({ where: { signalId }, orderBy: { id: "asc" } });

/** Move the Signal's Live processing to a fixed instant, as if the drain ran then. */
async function processedAt(signalId: string, iso: string) {
  await prisma.signals.update({ where: { id: signalId }, data: { processedAt: new Date(iso) } });
  await prisma.signalLocationOutcomes.updateMany({ where: { signalId, step: "PROCESSED" }, data: { locatedAt: new Date(iso) } });
}

const range = { from: "2026-10-26T00:00:00Z", to: "2026-11-08T23:59:59.999Z" };
const series = async () => {
  const metrics = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [SOURCE] });
  return metrics.weekly.map((w) => [w.isoWeek, w.total, w.noLocation, w.country, w.state, w.district, w.point]);
};

describeIfDb("the location Outcome log", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${STATE}, 'Teststate', 1, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${DISTRICT}, 'Testville', 2, ${STATE}, ARRAY[${COUNTRY}, ${STATE}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    sourceId = (await prisma.dataSources.create({ data: { name: SOURCE, type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.signals.deleteMany({ where: { sourceId } });
    await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, STATE, COUNTRY] } } });
  });

  it("createSignal writes the arrival Outcome with the Signal", async () => {
    const placed = await arrive("2026-10-27T09:00:00Z", { locationId: DISTRICT, pipelineVersion: "abc123", runId: "run-1" });
    expect(await outcomes(placed)).toMatchObject([
      {
        locatedAt: new Date("2026-10-27T09:00:00Z"),
        locationId: DISTRICT,
        level: 2,
        runKind: "LIVE",
        step: "ARRIVAL",
        pipelineVersion: "abc123",
        runId: "run-1",
      },
    ]);
    // A displacement Signal is read at its origin; a Signal with no location has a row with none.
    const displaced = await arrive("2026-10-27T09:00:00Z", { originId: STATE, destinationId: DISTRICT });
    expect(await outcomes(displaced)).toMatchObject([{ locationId: STATE, level: 1 }]);
    const unplaced = await arrive("2026-10-27T09:00:00Z");
    expect(await outcomes(unplaced)).toMatchObject([{ locationId: null, level: null, step: "ARRIVAL" }]);
    // A Signal a person entered gets none.
    const manual = await arrive("2026-10-27T09:00:00Z", { rawData: { manual: true }, locationId: DISTRICT });
    expect(await outcomes(manual)).toEqual([]);
    await prisma.signals.deleteMany({ where: { id: { in: [placed, displaced, unplaced, manual] } } });
  });

  it("markSignalsProcessed writes the run's Outcome; a skipped Signal gets none", async () => {
    const id = await arrive("2026-10-27T09:00:00Z");
    // The drain places the Signal, then marks it. Only the mark writes an Outcome.
    await updateSignalLocation({}, { id, locationId: STATE }, ctx);
    expect(await outcomes(id)).toHaveLength(1);
    // A stale revision marks nothing and writes nothing.
    expect(await markSignalsProcessed({}, { items: [{ id, revision: 7 }] }, ctx)).toBe(0);
    expect(await outcomes(id)).toHaveLength(1);

    expect(await markSignalsProcessed({}, { items: [{ id, revision: 0 }], pipelineVersion: "abc123", runId: "run-2" }, ctx)).toBe(1);
    const signal = await prisma.signals.findUniqueOrThrow({ where: { id } });
    expect((await outcomes(id))[1]).toMatchObject({
      locatedAt: signal.processedAt,
      locationId: STATE,
      level: 1,
      runKind: "LIVE",
      step: "PROCESSED",
      pipelineVersion: "abc123",
      runId: "run-2",
    });
    await prisma.signals.deleteMany({ where: { id } });
  });

  it("a replay adds Outcomes and changes neither the week nor the level of a Signal in the series", async () => {
    // W44: the Live run finds only the state. W45: one more Signal, at the district.
    const old = await arrive("2026-10-27T09:00:00Z");
    await updateSignalLocation({}, { id: old, locationId: STATE }, ctx);
    await markSignalsProcessed({}, { ids: [old] }, ctx);
    await processedAt(old, "2026-10-27T10:00:00Z");
    const other = await arrive("2026-11-03T09:00:00Z", { locationId: DISTRICT });
    await markSignalsProcessed({}, { ids: [other] }, ctx);
    await processedAt(other, "2026-11-03T10:00:00Z");

    const before = await series();
    expect(before).toEqual([
      ["2026-W44", 1, 0, 0, 1, 0, 0],
      ["2026-W45", 1, 0, 0, 0, 1, 0],
    ]);

    // A replay job re-geocodes the old Signal with a better pipeline: the district, now.
    await updateSignalLocation({}, { id: old, locationId: DISTRICT }, ctx);
    await markSignalsProcessed({}, { ids: [old], runKind: "REPLAY", pipelineVersion: "def456", runId: "replay-1" }, ctx);
    const replayed = await prisma.signals.findUniqueOrThrow({ where: { id: old } });
    expect(replayed.locationId).toBe(DISTRICT);
    expect(replayed.processedAt!.getTime()).toBeGreaterThan(new Date("2026-11-09T00:00:00Z").getTime());
    expect((await outcomes(old)).map((o) => [o.runKind, o.step, o.level])).toEqual([
      ["LIVE", "ARRIVAL", null],
      ["LIVE", "PROCESSED", 1],
      ["REPLAY", "PROCESSED", 2],
    ]);
    expect(await series()).toEqual(before);

    // A second pass that does not say it is a replay is one all the same:
    // a requeue and re-drain, or a NEEDS_RECOMPUTE pass.
    await prisma.signals.update({ where: { id: old }, data: { status: "NEEDS_RECOMPUTE" } });
    await markSignalsProcessed({}, { ids: [old] }, ctx);
    await requeueSignals({}, { ids: [old] }, ctx);
    await updateSignalLocation({}, { id: old, locationId: COUNTRY }, ctx);
    await markSignalsProcessed({}, { ids: [old], status: "FAILED" }, ctx);
    expect((await outcomes(old)).slice(3).map((o) => [o.runKind, o.level])).toEqual([
      ["REPLAY", 2],
      ["REPLAY", 0],
    ]);
    expect(await series()).toEqual(before);
  });

  it("keeps the level a run produced when the location is removed", async () => {
    const gone = `${RUN}-gone`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${gone}, 'Old district', 2, ${STATE}, ARRAY[${COUNTRY}, ${STATE}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    const id = await arrive("2026-10-28T09:00:00Z", { locationId: gone });
    // A gazetteer re-import replaces the location.
    await prisma.signals.update({ where: { id }, data: { locationId: DISTRICT } });
    await prisma.locations.delete({ where: { id: gone } });
    expect(await outcomes(id)).toMatchObject([{ locationId: null, level: 2 }]);
  });
});
