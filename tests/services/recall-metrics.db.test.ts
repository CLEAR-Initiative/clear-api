/**
 * Detection recall proxy against the real schema (ADR-0018): which reference
 * events count as alerted nearby (an Alert in the district, within the
 * window, on an Event with an ingested Signal from another feed), the
 * district found from a point, and the location filter. Brings its own
 * reference feed and a one-day window; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { fetchRecallRows, summariseRecall } from "../../src/services/recall-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `rc-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const OTHER_DISTRICT = `${RUN}-district2`;
const POINT = `${RUN}-point`;
const ABROAD = `${RUN}-abroad`;
const USER = `${RUN}-user`;
const REF = `${RUN}-ref`;
const FEED = `${RUN}-feed`;
const sourceIds: Record<string, string> = {};
const eventIds: string[] = [];
let n = 0;

const at = (iso: string) => new Date(iso);
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);

/** A reference event: one Signal of the reference feed at a point or a district, in its own Event. */
async function reference(dateIso: string, locationId: string | null) {
  const e = await prisma.events.create({
    data: { types: ["CE"], firstSignalCreatedAt: at(dateIso), lastSignalCreatedAt: at(dateIso), rank: 0, locationId },
  });
  eventIds.push(e.id);
  await prisma.signals.create({
    data: {
      sourceId: sourceIds[REF]!,
      externalId: `${RUN}-${n++}`,
      rawData: {},
      publishedAt: at(dateIso),
      collectedAt: at(dateIso),
      locationId,
      signalEvents: { create: { eventId: e.id, collectedAt: at(dateIso) } },
    },
  });
}

/** A CLEAR Event with an Alert, located somewhere, with the Signals given. */
async function alerted(opts: { onset: string; locationId: string; signals: Array<{ source: string; manual?: boolean }> }) {
  const e = await prisma.events.create({
    data: {
      types: ["CE"],
      startedAt: at(opts.onset),
      firstSignalCreatedAt: at(opts.onset),
      lastSignalCreatedAt: at(opts.onset),
      rank: 0,
      locationId: opts.locationId,
    },
  });
  eventIds.push(e.id);
  await prisma.alerts.create({ data: { eventId: e.id, status: "published", createdAt: at(opts.onset) } });
  for (const s of opts.signals) {
    await prisma.signals.create({
      data: {
        sourceId: sourceIds[s.source]!,
        externalId: `${RUN}-${n++}`,
        rawData: s.manual ? { manual: true, createdBy: USER } : {},
        publishedAt: at(opts.onset),
        collectedAt: at(opts.onset),
        locationId: opts.locationId,
        signalEvents: { create: { eventId: e.id, collectedAt: at(opts.onset) } },
      },
    });
  }
}

describeIfDb("detection recall proxy against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${OTHER_DISTRICT}, 'Farville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0.5 0.5)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${POINT}, 'Test Market', 4, ${DISTRICT}, ARRAY[${COUNTRY}, ${DISTRICT}]::text[], ST_GeomFromText('POINT(0.1 0.1)', 4326))`;
    await prisma.user.create({ data: { id: USER, name: "Analyst", email: `${RUN}@example.org`, role: "analyst" } });
    for (const name of [REF, FEED]) {
      const source = await prisma.dataSources.create({ data: { name, type: "test" } });
      sourceIds[name] = source.id;
    }
  });

  afterAll(async () => {
    await prisma.alerts.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.signals.deleteMany({ where: { sourceId: { in: Object.values(sourceIds) } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: Object.values(sourceIds) } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.locations.deleteMany({ where: { id: { in: [POINT, DISTRICT, OTHER_DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("credits a reference event only for an Alert from another feed in its district within the window", async () => {
    // CLEAR Alerts: one from the feed in the district on the 13th; one the
    // reference feed alone drove on the 15th (its reference Signal is a
    // reference event too, at the district itself); one from the feed but in
    // the other district on the 17th; one from a manual Signal only on the 18th.
    await alerted({ onset: "2026-10-13T00:00:00Z", locationId: DISTRICT, signals: [{ source: FEED }] });
    await alerted({ onset: "2026-10-15T00:00:00Z", locationId: DISTRICT, signals: [{ source: REF }] });
    await alerted({ onset: "2026-10-17T00:00:00Z", locationId: OTHER_DISTRICT, signals: [{ source: FEED }] });
    await alerted({ onset: "2026-10-18T00:00:00Z", locationId: DISTRICT, signals: [{ source: FEED, manual: true }] });
    // Reference events, placed at the point under the district unless said otherwise.
    await reference("2026-10-12T00:00:00Z", POINT); // the 13th's Alert is within one day: alerted
    await reference("2026-10-14T00:00:00Z", POINT); // the 13th is within one day too: alerted
    await reference("2026-10-15T00:00:00Z", POINT); // only the reference-driven Alert: not alerted
    await reference("2026-10-17T00:00:00Z", POINT); // the other district's Alert: not alerted
    await reference("2026-10-18T00:00:00Z", POINT); // a manual-only Alert: not alerted
    await reference("2026-10-13T00:00:00Z", null); // no location, so no district: not alerted
    await reference("2026-10-13T00:00:00Z", ABROAD); // abroad: out of the country's scope
    await reference("2026-10-20T00:00:00Z", POINT); // after the range

    const range = { from: at("2026-10-12T00:00:00Z"), to: at("2026-10-18T23:59:59.999Z") };
    const rows = await fetchRecallRows(prisma, range, COUNTRY, REF, 1);
    const m = summariseRecall(rows, range, "DAY");
    expect(m).toMatchObject({ groundTruth: 6, alerted: 2 });
    expect(m.series.map((b) => [b.label, b.groundTruth, b.alerted])).toEqual([
      ["2026-10-12", 1, 1],
      ["2026-10-13", 0, 0],
      ["2026-10-14", 1, 1],
      ["2026-10-15", 2, 0],
      ["2026-10-16", 0, 0],
      ["2026-10-17", 1, 0],
      ["2026-10-18", 1, 0],
    ]);

    // Without the location, the reference events with no district and abroad join the denominator only.
    const everywhere = summariseRecall(await fetchRecallRows(prisma, range, null, REF, 1), range, "WEEK");
    expect(everywhere.alerted).toBe(2);
    expect(everywhere.groundTruth).toBeGreaterThanOrEqual(8);

    // A wider window reaches both reference events of the 15th from the 13th's Alert.
    expect(summariseRecall(await fetchRecallRows(prisma, range, COUNTRY, REF, 3), range, "WEEK").alerted).toBe(4);
  });
});
