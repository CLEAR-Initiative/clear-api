/**
 * Location precision against the real schema (ADR-0012): which Signals count
 * (ingested, not retracted, not dummy), which location each is read at, the
 * instant that puts it in range, the source and location filters, and the
 * correction counts. Self-seeding and scoped to its own locations and
 * sources; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeLocationPrecisionMetrics } from "../../src/services/location-precision-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `lp-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const STATE = `${RUN}-state`;
const DISTRICT = `${RUN}-district`;
const POINT = `${RUN}-point`;
const ABROAD = `${RUN}-abroad`;
const USER = `${RUN}-user`;
const X = `${RUN}-x`;
const DM = `${RUN}-dm`;
const FIXED = `${RUN}-fixed`;
const sourceIds: Record<string, string> = {};
const signalIds: string[] = [];
let n = 0;

const at = (iso: string) => new Date(iso);

async function signal(opts: {
  source: string;
  /** The instant the drain located it; null for a source placed on arrival. */
  processedAt: string | null;
  collectedAt: string;
  locationId?: string | null;
  originId?: string | null;
  destinationId?: string | null;
  history?: boolean;
  manual?: boolean;
  retracted?: boolean;
  isDummy?: boolean;
  locationCorrectedAt?: string;
}) {
  const s = await prisma.signals.create({
    data: {
      sourceId: sourceIds[opts.source]!,
      externalId: `${RUN}-${n++}`,
      rawData: opts.manual ? { manual: true, createdBy: USER } : {},
      publishedAt: at("2026-10-01T09:00:00Z"),
      collectedAt: at(opts.collectedAt),
      processedAt: opts.processedAt ? at(opts.processedAt) : null,
      locationId: opts.locationId ?? null,
      originId: opts.originId ?? null,
      destinationId: opts.destinationId ?? null,
      submittedById: opts.history ? USER : null,
      retracted: opts.retracted ?? false,
      isDummy: opts.isDummy ?? false,
      locationCorrectedAt: opts.locationCorrectedAt ? at(opts.locationCorrectedAt) : null,
    },
  });
  signalIds.push(s.id);
  return s.id;
}

describeIfDb("location precision against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${STATE}, 'Teststate', 1, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${DISTRICT}, 'Testville', 2, ${STATE}, ARRAY[${COUNTRY}, ${STATE}]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${POINT}, 'Test market', 4, ${DISTRICT}, ARRAY[${COUNTRY}, ${STATE}, ${DISTRICT}]::text[], ST_GeomFromText('POINT(0.1 0.1)', 4326))`;
    await prisma.user.create({ data: { id: USER, name: "Analyst", email: `${RUN}@example.org`, role: "analyst" } });
    for (const name of [X, DM, FIXED]) {
      const source = await prisma.dataSources.create({ data: { name, type: "test" } });
      sourceIds[name] = source.id;
    }
  });

  afterAll(async () => {
    await prisma.signalLocationChallenges.deleteMany({ where: { signalId: { in: signalIds } } });
    await prisma.signals.deleteMany({ where: { sourceId: { in: Object.values(sourceIds) } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: Object.values(sourceIds) } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.locations.deleteMany({ where: { id: { in: [POINT, DISTRICT, STATE, COUNTRY, ABROAD] } } });
  });

  it("counts each ingested Signal under its location's level, by source and week", async () => {
    // The text source: located by the drain (processedAt) in W44 and W45.
    const district = await signal({ source: X, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: DISTRICT });
    await signal({ source: X, processedAt: "2026-10-27T11:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: STATE });
    await signal({ source: X, processedAt: "2026-10-30T11:00:00Z", collectedAt: "2026-10-30T09:00:00Z", locationId: COUNTRY });
    await signal({ source: X, processedAt: "2026-11-03T11:00:00Z", collectedAt: "2026-11-03T09:00:00Z", locationId: POINT });
    // Displacement: read at its origin (the state), not its destination (the district).
    await signal({ source: X, processedAt: "2026-11-03T12:00:00Z", collectedAt: "2026-11-03T09:00:00Z", originId: STATE, destinationId: DISTRICT });
    // No location at all.
    await signal({ source: X, processedAt: "2026-11-04T12:00:00Z", collectedAt: "2026-11-04T09:00:00Z" });
    // Abroad: counted globally, left out under the country filter.
    await signal({ source: X, processedAt: "2026-10-28T12:00:00Z", collectedAt: "2026-10-28T09:00:00Z", locationId: ABROAD });
    // Collected in range but located (processed) before it: out of range.
    await signal({ source: X, processedAt: "2026-10-25T23:00:00Z", collectedAt: "2026-10-26T09:00:00Z", locationId: DISTRICT });
    // Not ingested: history, manual, retracted, dummy.
    await signal({ source: X, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: DISTRICT, history: true });
    await signal({ source: X, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: DISTRICT, manual: true });
    await signal({ source: X, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: DISTRICT, retracted: true });
    await signal({ source: X, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z", locationId: DISTRICT, isDummy: true });
    // A source with coordinates: placed on arrival, so collectedAt puts it in range.
    await signal({ source: DM, processedAt: null, collectedAt: "2026-10-26T00:00:00Z", locationId: POINT });
    await signal({ source: DM, processedAt: null, collectedAt: "2026-11-08T23:59:59.000Z", locationId: POINT });
    await signal({ source: DM, processedAt: null, collectedAt: "2026-11-09T00:00:00Z", locationId: POINT }); // after the range
    // Corrections: two in range (one open, one declined), one before it.
    await prisma.signalLocationChallenges.createMany({
      data: [
        { signalId: district, createdBy: USER, status: "consideration", createdAt: at("2026-10-29T10:00:00Z"), previousLocationId: DISTRICT },
        { signalId: district, createdBy: USER, status: "declined", createdAt: at("2026-11-05T10:00:00Z"), previousLocationId: DISTRICT },
        { signalId: district, createdBy: USER, status: "accepted", createdAt: at("2026-10-20T10:00:00Z"), previousLocationId: DISTRICT },
      ],
    });

    const range = { from: "2026-10-26T00:00:00Z", to: "2026-11-08T23:59:59.999Z" };
    const all = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [X, DM] });
    expect(all.signalsInRange).toBe(9);
    expect(all.bySource).toEqual([
      { source: X, total: 7, noLocation: 1, country: 2, state: 2, district: 1, point: 1 },
      { source: DM, total: 2, noLocation: 0, country: 0, state: 0, district: 0, point: 2 },
    ]);
    expect(all.weekly.map((w) => [w.source, w.isoWeek, w.total, w.district + w.point])).toEqual([
      [X, "2026-W44", 4, 1],
      [X, "2026-W45", 3, 1],
      [DM, "2026-W44", 1, 1],
      [DM, "2026-W45", 1, 1],
    ]);
    expect(all.corrections).toEqual({ open: 1, accepted: 0, corrected: 0, declined: 1, superseded: 0 });

    // Inside Testland: the Signal abroad and the one with no location drop out.
    const inCountry = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [X, DM], locationId: COUNTRY });
    expect(inCountry.bySource[0]).toEqual({ source: X, total: 5, noLocation: 0, country: 1, state: 2, district: 1, point: 1 });
    expect(inCountry.corrections.open).toBe(1);

    // Inside the district: the district Signal and the point (its ancestors include the district).
    const inDistrict = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [X], locationId: DISTRICT });
    expect(inDistrict.bySource).toEqual([{ source: X, total: 2, noLocation: 0, country: 0, state: 0, district: 1, point: 1 }]);

    // One source only.
    const dmOnly = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [DM] });
    expect(dmOnly.bySource.map((s) => s.source)).toEqual([DM]);
    expect(dmOnly.corrections).toEqual({ open: 0, accepted: 0, corrected: 0, declined: 0, superseded: 0 });
  });

  it("reads a Signal a person corrected at the location the pipeline gave it", async () => {
    const located = { source: FIXED, processedAt: "2026-10-27T10:00:00Z", collectedAt: "2026-10-27T09:00:00Z" };
    // The pipeline put it at the state; an accepted challenge wrote a point.
    const accepted = await signal({ ...located, locationId: POINT, locationCorrectedAt: "2026-11-02T10:00:00Z" });
    // The pipeline found nothing; the admin placed a point.
    const unlocated = await signal({ ...located, locationId: POINT, locationCorrectedAt: "2026-11-02T10:00:00Z" });
    // Corrected twice: the first applied challenge holds the pipeline's location.
    const twice = await signal({ ...located, locationId: POINT, locationCorrectedAt: "2026-11-04T10:00:00Z" });
    await prisma.signalLocationChallenges.createMany({
      data: [
        { signalId: accepted, createdBy: USER, status: "declined", createdAt: at("2026-10-28T10:00:00Z"), decidedAt: at("2026-10-29T10:00:00Z"), previousLocationId: STATE },
        { signalId: accepted, createdBy: USER, status: "accepted", createdAt: at("2026-11-01T10:00:00Z"), decidedAt: at("2026-11-02T10:00:00Z"), previousLocationId: STATE },
        { signalId: unlocated, createdBy: USER, status: "corrected", createdAt: at("2026-11-01T10:00:00Z"), decidedAt: at("2026-11-02T10:00:00Z"), previousLocationId: null },
        { signalId: twice, createdBy: USER, status: "accepted", createdAt: at("2026-10-28T10:00:00Z"), decidedAt: at("2026-10-29T10:00:00Z"), previousLocationId: COUNTRY },
        { signalId: twice, createdBy: USER, status: "corrected", createdAt: at("2026-11-03T10:00:00Z"), decidedAt: at("2026-11-04T10:00:00Z"), previousLocationId: POINT },
      ],
    });

    const range = { from: "2026-10-26T00:00:00Z", to: "2026-11-08T23:59:59.999Z" };
    const fixed = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [FIXED] });
    expect(fixed.bySource).toEqual([{ source: FIXED, total: 3, noLocation: 1, country: 1, state: 1, district: 0, point: 0 }]);

    // The location filter reads the same location: the human point is not in the district.
    const inDistrict = await computeLocationPrecisionMetrics(prisma, { ...range, sourceNames: [FIXED], locationId: DISTRICT });
    expect(inDistrict.bySource).toEqual([]);
    expect(inDistrict.corrections).toEqual({ open: 0, accepted: 0, corrected: 0, declined: 0, superseded: 0 });
  });
});
