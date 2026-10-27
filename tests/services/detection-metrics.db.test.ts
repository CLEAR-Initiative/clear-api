/**
 * Time to detection against the real schema (ADR-0011): which Signal is an
 * Event's first ingested one (not history, not retracted, not dummy), which
 * Events are in range and in the location, and the counts that come out.
 * Self-seeding and scoped to its own locations; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeDetectionMetrics } from "../../src/services/detection-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `ttd-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const USER = `${RUN}-user`;
const eventIds: string[] = [];
const sourceIds: string[] = [];
let sourceId = "";
let n = 0;

const at = (iso: string) => new Date(iso);

async function event(opts: {
  onset: string | null;
  firstSignalCreatedAt: string;
  locationId?: string;
  isDummy?: boolean;
  signals: Array<{ at: string; history?: boolean; manual?: boolean; retracted?: boolean; isDummy?: boolean }>;
}) {
  const e = await prisma.events.create({
    data: {
      types: ["FL"],
      startedAt: opts.onset ? at(opts.onset) : null,
      firstSignalCreatedAt: at(opts.firstSignalCreatedAt),
      lastSignalCreatedAt: at(opts.firstSignalCreatedAt),
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
      isDummy: opts.isDummy ?? false,
    },
  });
  eventIds.push(e.id);
  for (const s of opts.signals) {
    await prisma.signals.create({
      data: {
        sourceId,
        externalId: `${RUN}-${n++}`,
        // As createManualSignal writes a hand-filed Signal.
        rawData: s.manual ? { manual: true, createdBy: USER } : {},
        publishedAt: at(s.at),
        submittedById: s.history ? USER : null,
        retracted: s.retracted ?? false,
        isDummy: s.isDummy ?? false,
        signalEvents: { create: { eventId: e.id, collectedAt: at(s.at) } },
      },
    });
  }
  return e.id;
}

describeIfDb("time to detection against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    await prisma.user.create({ data: { id: USER, name: "Analyst", email: `${RUN}@example.org`, role: "analyst" } });
    const source = await prisma.dataSources.create({ data: { name: `${RUN}-feed`, type: "test" } });
    sourceId = source.id;
    sourceIds.push(source.id);
  });

  afterAll(async () => {
    await prisma.signals.deleteMany({ where: { sourceId: { in: sourceIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: sourceIds } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("measures each Event in range from its first ingested Signal", async () => {
    // Counted, same day (W40); the later Signal does not matter.
    await event({
      onset: "2026-09-29T00:00:00Z",
      firstSignalCreatedAt: "2026-09-29T10:00:00Z",
      signals: [{ at: "2026-09-29T10:00:00Z" }, { at: "2026-10-03T10:00:00Z" }],
    });
    // Counted, next day (W40): an earlier history case, an earlier manual
    // Signal, an earlier retracted Signal and an earlier dummy Signal are not
    // its first ingested Signal.
    await event({
      onset: "2026-09-29T00:00:00Z",
      firstSignalCreatedAt: "2026-09-01T00:00:00Z",
      signals: [
        { at: "2026-09-01T00:00:00Z", history: true },
        { at: "2026-09-29T00:30:00Z", manual: true },
        { at: "2026-09-29T01:00:00Z", retracted: true },
        { at: "2026-09-29T02:00:00Z", isDummy: true },
        { at: "2026-09-30T08:00:00Z" },
      ],
    });
    // Counted, 8 days (W41), at the country rather than the district.
    await event({
      onset: "2026-09-30T00:00:00Z",
      firstSignalCreatedAt: "2026-10-08T09:00:00Z",
      locationId: COUNTRY,
      signals: [{ at: "2026-10-08T09:00:00Z" }],
    });
    // Excluded, one per reason.
    await event({ onset: "2026-10-01T00:00:00Z", firstSignalCreatedAt: "2026-10-01T00:00:00Z", signals: [{ at: "2026-10-01T00:00:00Z", history: true }] });
    // A manual-only Event was not detected by CLEAR either.
    await event({ onset: "2026-10-01T00:00:00Z", firstSignalCreatedAt: "2026-10-01T11:00:00Z", signals: [{ at: "2026-10-01T11:00:00Z", manual: true }] });
    await event({ onset: null, firstSignalCreatedAt: "2026-10-02T10:00:00Z", signals: [{ at: "2026-10-02T10:00:00Z" }] });
    await event({ onset: "2026-10-01T00:00:00Z", firstSignalCreatedAt: "2026-10-02T00:00:00Z", signals: [{ at: "2026-10-02T00:00:00Z" }] });
    await event({ onset: "2026-10-05T00:00:00Z", firstSignalCreatedAt: "2026-10-04T10:00:00Z", signals: [{ at: "2026-10-04T10:00:00Z" }] });
    // Not in the metric: first ingested before the range (though signalled in
    // it), after it, a dummy Event, and an Event abroad.
    await event({
      onset: "2026-09-20T00:00:00Z",
      firstSignalCreatedAt: "2026-09-20T10:00:00Z",
      signals: [{ at: "2026-09-20T10:00:00Z" }, { at: "2026-10-01T10:00:00Z" }],
    });
    await event({ onset: "2026-10-20T00:00:00Z", firstSignalCreatedAt: "2026-10-20T10:00:00Z", signals: [{ at: "2026-10-20T10:00:00Z" }] });
    await event({ onset: "2026-10-01T00:00:00Z", firstSignalCreatedAt: "2026-10-01T10:00:00Z", isDummy: true, signals: [{ at: "2026-10-01T10:00:00Z" }] });
    await event({ onset: "2026-10-01T00:00:00Z", firstSignalCreatedAt: "2026-10-01T10:00:00Z", locationId: ABROAD, signals: [{ at: "2026-10-01T10:00:00Z" }] });

    const m = await computeDetectionMetrics(prisma, {
      from: "2026-09-28T00:00:00Z",
      to: "2026-10-11T23:59:59.999Z",
      locationId: COUNTRY,
    });
    expect(m).toMatchObject({ eventsInRange: 8, withOnset: 7, counted: 3, sameDay: 1, byNextDay: 2 });
    expect(m.histogram.map((b) => b.count)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(m.exclusions).toEqual([
      { reason: "NO_INGESTED_SIGNAL", count: 2 },
      { reason: "NO_ONSET", count: 1 },
      { reason: "COARSE_ONSET", count: 0 },
      { reason: "DATE_ONLY_FIRST_SIGNAL", count: 1 },
      { reason: "BEFORE_ONSET", count: 1 },
    ]);
    // Every excluded Event falls in W40, the two history/manual-only ones by
    // their `firstSignalCreatedAt`.
    expect(m.weekly.map((w) => [w.isoWeek, w.eventsInRange, w.counted, w.sameDay, w.byNextDay, w.isPartial])).toEqual([
      ["2026-W40", 7, 2, 1, 2, false],
      ["2026-W41", 1, 1, 0, 0, false],
    ]);

    // The district alone leaves out the Event filed at the country.
    const district = await computeDetectionMetrics(prisma, {
      from: "2026-09-28T00:00:00Z",
      to: "2026-10-11T23:59:59.999Z",
      locationId: DISTRICT,
    });
    expect(district).toMatchObject({ eventsInRange: 7, counted: 2 });
  });
});
