/**
 * Time to alert against the real schema (ADR-0017): which Alerts are in
 * range and in the location, every status counting, dummy Events left out,
 * and the counts that come out. Self-seeding and scoped to its own
 * locations; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeTimeToAlertMetrics } from "../../src/services/time-to-alert-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `tta-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const eventIds: string[] = [];

const at = (iso: string) => new Date(iso);

async function alertedEvent(opts: {
  onset: string | null;
  onsetAccuracy?: "DAY" | "WEEK" | "MONTH" | "YEAR";
  alertAt: string;
  status?: "draft" | "published" | "archived";
  locationId?: string;
  isDummy?: boolean;
}) {
  const e = await prisma.events.create({
    data: {
      types: ["FL"],
      startedAt: opts.onset ? at(opts.onset) : null,
      startedAtAccuracy: opts.onsetAccuracy,
      firstSignalCreatedAt: at(opts.alertAt),
      lastSignalCreatedAt: at(opts.alertAt),
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
      isDummy: opts.isDummy ?? false,
    },
  });
  eventIds.push(e.id);
  await prisma.alerts.create({ data: { eventId: e.id, status: opts.status ?? "published", createdAt: at(opts.alertAt) } });
  return e.id;
}

describeIfDb("time to alert against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
  });

  afterAll(async () => {
    await prisma.alerts.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("measures each Alert raised in range from its Event's onset", async () => {
    // Counted: same day and next day (W40); eight days later, archived, at the country (W41).
    await alertedEvent({ onset: "2026-09-29T00:00:00Z", alertAt: "2026-09-29T18:00:00Z" });
    await alertedEvent({ onset: "2026-09-29T00:00:00Z", alertAt: "2026-09-30T08:00:00Z" });
    await alertedEvent({ onset: "2026-09-30T00:00:00Z", alertAt: "2026-10-08T09:00:00Z", status: "archived", locationId: COUNTRY });
    // Excluded, one per reason, all in W40.
    await alertedEvent({ onset: null, alertAt: "2026-10-02T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", onsetAccuracy: "MONTH", alertAt: "2026-10-02T11:00:00Z" });
    await alertedEvent({ onset: "2026-10-05T00:00:00Z", alertAt: "2026-10-04T10:00:00Z" });
    // Not in the metric: raised before the range, after it, for a dummy Event; abroad is out of the country's scope only.
    await alertedEvent({ onset: "2026-09-20T00:00:00Z", alertAt: "2026-09-20T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-20T00:00:00Z", alertAt: "2026-10-20T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", alertAt: "2026-10-01T10:00:00Z", isDummy: true });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", alertAt: "2026-10-01T10:00:00Z", locationId: ABROAD });

    const range = { from: "2026-09-28T00:00:00Z", to: "2026-10-11T23:59:59.999Z" };
    const m = await computeTimeToAlertMetrics(prisma, { ...range, locationId: COUNTRY });
    expect(m).toMatchObject({ alertsInRange: 6, counted: 3, sameDay: 1, byNextDay: 2 });
    expect(m.exclusions).toEqual([
      { reason: "NO_ONSET", count: 1 },
      { reason: "COARSE_ONSET", count: 1 },
      { reason: "BEFORE_ONSET", count: 1 },
    ]);
    expect(m.series.map((b) => [b.label, b.alertsInRange, b.counted, b.sameDay, b.byNextDay, b.isPartial])).toEqual([
      ["2026-W40", 5, 2, 1, 2, false],
      ["2026-W41", 1, 1, 0, 0, false],
    ]);

    // The district alone leaves out the Alert at the country; no location takes the Alert abroad too.
    expect(await computeTimeToAlertMetrics(prisma, { ...range, locationId: DISTRICT })).toMatchObject({ alertsInRange: 5, counted: 2 });
    const everywhere = await computeTimeToAlertMetrics(prisma, range);
    expect(everywhere.alertsInRange).toBeGreaterThanOrEqual(7);
  });
});
