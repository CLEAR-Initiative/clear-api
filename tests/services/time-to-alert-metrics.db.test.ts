/**
 * Time to alert against the real schema (ADR-0017): which Alerts are in
 * range and in the location, every status counting, dummy Events left out,
 * and the counts that come out. Self-seeding and scoped to its own
 * locations; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { ALERT_TIMESTAMPS_MIGRATION, computeTimeToAlertMetrics } from "../../src/services/time-to-alert-metrics.js";
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
  alertAt: string | Date;
  /** The Event's first Signal; the Alert's instant unless said otherwise, so the two can be told apart. */
  firstSignalAt?: string;
  status?: "draft" | "published" | "archived";
  locationId?: string;
  isDummy?: boolean;
}) {
  const e = await prisma.events.create({
    data: {
      types: ["FL"],
      startedAt: opts.onset ? at(opts.onset) : null,
      startedAtAccuracy: opts.onsetAccuracy,
      firstSignalCreatedAt: opts.firstSignalAt ? at(opts.firstSignalAt) : at(String(opts.alertAt instanceof Date ? opts.alertAt.toISOString() : opts.alertAt)),
      lastSignalCreatedAt: opts.firstSignalAt ? at(opts.firstSignalAt) : at(String(opts.alertAt instanceof Date ? opts.alertAt.toISOString() : opts.alertAt)),
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
      isDummy: opts.isDummy ?? false,
    },
  });
  eventIds.push(e.id);
  await prisma.alerts.create({
    data: { eventId: e.id, status: opts.status ?? "published", createdAt: opts.alertAt instanceof Date ? opts.alertAt : at(opts.alertAt) },
  });
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
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD, `${RUN}-stamp`] } } });
  });

  it("measures each Alert raised in range from its Event's onset", async () => {
    // Counted: same day and next day (W40); eight days later, archived, at the country (W41); a draft
    // Alert the same day whose Event's first Signal is a month before the range (W41): the range is the Alert's.
    await alertedEvent({ onset: "2026-09-29T00:00:00Z", alertAt: "2026-09-29T18:00:00Z" });
    await alertedEvent({ onset: "2026-09-29T00:00:00Z", alertAt: "2026-09-30T08:00:00Z" });
    await alertedEvent({ onset: "2026-09-30T00:00:00Z", alertAt: "2026-10-08T09:00:00Z", status: "archived", locationId: COUNTRY });
    await alertedEvent({ onset: "2026-10-06T00:00:00Z", alertAt: "2026-10-06T12:00:00Z", firstSignalAt: "2026-09-01T09:00:00Z", status: "draft" });
    // Excluded, one per reason, all in W40.
    await alertedEvent({ onset: null, alertAt: "2026-10-02T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", onsetAccuracy: "MONTH", alertAt: "2026-10-02T11:00:00Z" });
    await alertedEvent({ onset: "2026-10-05T00:00:00Z", alertAt: "2026-10-04T10:00:00Z" });
    // Not in the metric: raised before the range, after it (even with the Event's first Signal inside it),
    // for a dummy Event; abroad is out of the country's scope only.
    await alertedEvent({ onset: "2026-09-20T00:00:00Z", alertAt: "2026-09-20T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-20T00:00:00Z", alertAt: "2026-10-20T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", alertAt: "2026-10-20T11:00:00Z", firstSignalAt: "2026-10-01T10:00:00Z" });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", alertAt: "2026-10-01T10:00:00Z", isDummy: true });
    await alertedEvent({ onset: "2026-10-01T00:00:00Z", alertAt: "2026-10-01T10:00:00Z", locationId: ABROAD });

    const range = { from: "2026-09-28T00:00:00Z", to: "2026-10-11T23:59:59.999Z" };
    const m = await computeTimeToAlertMetrics(prisma, { ...range, locationId: COUNTRY });
    expect(m).toMatchObject({ alertsInRange: 7, counted: 4, sameDay: 2, byNextDay: 3 });
    expect(m.exclusions).toEqual([
      { reason: "BACKFILLED_TIMESTAMP", count: 0 },
      { reason: "NO_ONSET", count: 1 },
      { reason: "COARSE_ONSET", count: 1 },
      { reason: "BEFORE_ONSET", count: 1 },
    ]);
    expect(m.series.map((b) => [b.label, b.alertsInRange, b.counted, b.sameDay, b.byNextDay, b.isPartial])).toEqual([
      ["2026-W40", 5, 2, 1, 2, false],
      ["2026-W41", 2, 2, 1, 1, false],
    ]);

    // The district alone leaves out the Alert at the country; no location takes the Alert abroad too.
    expect(await computeTimeToAlertMetrics(prisma, { ...range, locationId: DISTRICT })).toMatchObject({ alertsInRange: 6, counted: 3 });
    const everywhere = await computeTimeToAlertMetrics(prisma, range);
    expect(everywhere.alertsInRange).toBeGreaterThanOrEqual(8);
  });

  it("excludes an Alert stamped with the timestamp migration's run instant", async () => {
    const STAMP = `${RUN}-stamp`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${STAMP}, 'Stampland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(2 2)', 4326))`;
    const [window] = await prisma.$queryRaw<Array<{ startedAt: Date; finishedAt: Date | null }>>`
      SELECT MIN("started_at") AS "startedAt", MAX("finished_at") AS "finishedAt"
      FROM "_prisma_migrations" WHERE "migration_name" = ${ALERT_TIMESTAMPS_MIGRATION} AND "rolled_back_at" IS NULL`;
    expect(window?.startedAt).toBeInstanceOf(Date);
    const stamped = window!.startedAt;
    const onset = new Date(Date.UTC(stamped.getUTCFullYear(), stamped.getUTCMonth(), stamped.getUTCDate()));
    // One Alert at the run instant (excluded), one a minute after the run finished (counted, same day).
    await alertedEvent({ onset: onset.toISOString(), alertAt: stamped, locationId: STAMP });
    const after = new Date((window!.finishedAt ?? stamped).getTime() + 60_000);
    await alertedEvent({ onset: onset.toISOString(), alertAt: after, locationId: STAMP });
    const m = await computeTimeToAlertMetrics(prisma, {
      from: new Date(stamped.getTime() - 24 * 60 * 60 * 1000),
      to: new Date(after.getTime() + 24 * 60 * 60 * 1000),
      locationId: STAMP,
    });
    expect(m).toMatchObject({ alertsInRange: 2, counted: 1, sameDay: 1 });
    expect(m.exclusions[0]).toEqual({ reason: "BACKFILLED_TIMESTAMP", count: 1 });
  });
});
