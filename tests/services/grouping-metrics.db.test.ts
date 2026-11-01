/**
 * Grouping proxies against the real schema (ADR-0018): which Signals count
 * as grouped (an Event with another ingested Signal), which Events hold one
 * ingested Signal, the source each is read under, and the location and
 * source filters. Self-seeding and scoped to its own locations and sources;
 * run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeSignalsGrouped, computeSingleSignalEvents } from "../../src/services/grouping-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `grp-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const USER = `${RUN}-user`;
const X = `${RUN}-x`;
const DM = `${RUN}-dm`;
const sourceIds: Record<string, string> = {};
const eventIds: string[] = [];
let n = 0;

const at = (iso: string) => new Date(iso);

async function event(opts: {
  firstSignalAt: string;
  locationId?: string;
  signals: Array<{ source: string; at: string; locationId?: string | null; history?: boolean; manual?: boolean; retracted?: boolean }>;
}) {
  const e = await prisma.events.create({
    data: {
      types: ["FL"],
      firstSignalCreatedAt: at(opts.firstSignalAt),
      lastSignalCreatedAt: at(opts.firstSignalAt),
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
    },
  });
  eventIds.push(e.id);
  for (const s of opts.signals) {
    await prisma.signals.create({
      data: {
        sourceId: sourceIds[s.source]!,
        externalId: `${RUN}-${n++}`,
        rawData: s.manual ? { manual: true, createdBy: USER } : {},
        publishedAt: at(s.at),
        collectedAt: at(s.at),
        locationId: s.locationId === undefined ? DISTRICT : s.locationId,
        submittedById: s.history ? USER : null,
        retracted: s.retracted ?? false,
        signalEvents: { create: { eventId: e.id, collectedAt: at(s.at) } },
      },
    });
  }
  return e.id;
}

describeIfDb("grouping proxies against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    await prisma.user.create({ data: { id: USER, name: "Analyst", email: `${RUN}@example.org`, role: "analyst" } });
    for (const name of [X, DM]) {
      const source = await prisma.dataSources.create({ data: { name, type: "test" } });
      sourceIds[name] = source.id;
    }
  });

  afterAll(async () => {
    await prisma.signals.deleteMany({ where: { sourceId: { in: Object.values(sourceIds) } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: Object.values(sourceIds) } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("reads grouped Signals per source and single-Signal Events per first source", async () => {
    // An Event of two ingested Signals from two sources: both grouped; first source X.
    await event({ firstSignalAt: "2026-10-12T09:00:00Z", signals: [{ source: X, at: "2026-10-12T09:00:00Z" }, { source: DM, at: "2026-10-12T10:00:00Z" }] });
    // An Event of one ingested Signal plus a retracted one and a manual one: not grouped; a single-Signal Event under DM.
    await event({
      firstSignalAt: "2026-10-13T09:00:00Z",
      signals: [
        { source: DM, at: "2026-10-13T09:00:00Z" },
        { source: X, at: "2026-10-13T09:30:00Z", retracted: true },
        { source: X, at: "2026-10-13T09:40:00Z", manual: true },
      ],
    });
    // An Event of one X Signal: not grouped; single under X.
    await event({ firstSignalAt: "2026-10-14T09:00:00Z", signals: [{ source: X, at: "2026-10-14T09:00:00Z" }] });
    // An Event of two X Signals, one a history case: the ingested one has no ingested company.
    await event({ firstSignalAt: "2026-10-15T09:00:00Z", signals: [{ source: X, at: "2026-10-15T09:00:00Z" }, { source: X, at: "2026-10-15T09:10:00Z", history: true }] });
    // Abroad: out of the country's scope for both metrics.
    await event({ firstSignalAt: "2026-10-16T09:00:00Z", locationId: ABROAD, signals: [{ source: X, at: "2026-10-16T09:00:00Z", locationId: ABROAD }, { source: DM, at: "2026-10-16T09:00:00Z", locationId: ABROAD }] });
    // Before the range.
    await event({ firstSignalAt: "2026-10-05T09:00:00Z", signals: [{ source: X, at: "2026-10-05T09:00:00Z" }, { source: DM, at: "2026-10-05T09:00:00Z" }] });

    const input = { from: "2026-10-12T00:00:00Z", to: "2026-10-18T23:59:59.999Z", locationId: COUNTRY, sourceNames: [X, DM], granularity: "WEEK" as const };
    const grouped = await computeSignalsGrouped(prisma, input);
    expect(grouped.bySource).toEqual([
      { source: X, numerator: 1, denominator: 3 },
      { source: DM, numerator: 1, denominator: 2 },
    ]);
    expect(grouped.series.map((r) => [r.source, r.label, r.numerator, r.denominator])).toEqual([
      [X, "2026-W42", 1, 3],
      [DM, "2026-W42", 1, 2],
    ]);

    const single = await computeSingleSignalEvents(prisma, input);
    expect(single.bySource).toEqual([
      { source: X, numerator: 2, denominator: 3 },
      { source: DM, numerator: 1, denominator: 1 },
    ]);

    // Without the location, the Event abroad joins both reads.
    expect((await computeSignalsGrouped(prisma, { ...input, locationId: null })).bySource).toEqual([
      { source: X, numerator: 2, denominator: 4 },
      { source: DM, numerator: 2, denominator: 3 },
    ]);
    expect((await computeSingleSignalEvents(prisma, { ...input, locationId: null, sourceNames: [X] })).bySource).toEqual([{ source: X, numerator: 2, denominator: 4 }]);
  });
});
