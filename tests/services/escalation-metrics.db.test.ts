/**
 * Events escalated against the real schema (ADR-0017): which Events are in
 * range and in the location, an Event escalated by two users counting once,
 * dummy Events left out. Self-seeding and scoped to its own locations; run
 * with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeEscalationMetrics } from "../../src/services/escalation-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `esc-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const USERS = [`${RUN}-u1`, `${RUN}-u2`];
const eventIds: string[] = [];

const at = (iso: string) => new Date(iso);

async function event(opts: { firstSignalAt: string; escalatedBy?: string[]; locationId?: string; isDummy?: boolean }) {
  const e = await prisma.events.create({
    data: {
      types: ["FL"],
      firstSignalCreatedAt: at(opts.firstSignalAt),
      lastSignalCreatedAt: at(opts.firstSignalAt),
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
      isDummy: opts.isDummy ?? false,
    },
  });
  eventIds.push(e.id);
  for (const userId of opts.escalatedBy ?? []) {
    await prisma.eventEscaladedByUsers.create({
      data: { userId, eventId: e.id, validFrom: at(opts.firstSignalAt), validTo: at("2026-10-30T00:00:00Z") },
    });
  }
  return e.id;
}

describeIfDb("events escalated against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    for (const id of USERS) {
      await prisma.user.create({ data: { id, name: "Analyst", email: `${id}@example.org`, role: "analyst" } });
    }
  });

  afterAll(async () => {
    await prisma.eventEscaladedByUsers.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("counts each Event in range once, escalated or not", async () => {
    await event({ firstSignalAt: "2026-10-12T09:00:00Z", escalatedBy: [USERS[0]!] });
    await event({ firstSignalAt: "2026-10-12T10:00:00Z", escalatedBy: USERS });
    await event({ firstSignalAt: "2026-10-14T09:00:00Z" });
    // Not in the metric: a dummy Event, an Event before the range, one after it; abroad is out of the country's scope only.
    await event({ firstSignalAt: "2026-10-14T11:00:00Z", escalatedBy: [USERS[0]!], isDummy: true });
    await event({ firstSignalAt: "2026-10-05T09:00:00Z", escalatedBy: [USERS[0]!] });
    await event({ firstSignalAt: "2026-10-20T09:00:00Z", escalatedBy: [USERS[0]!] });
    await event({ firstSignalAt: "2026-10-15T09:00:00Z", escalatedBy: [USERS[1]!], locationId: ABROAD });

    const range = { from: "2026-10-12T00:00:00Z", to: "2026-10-18T23:59:59.999Z", granularity: "DAY" as const };
    const m = await computeEscalationMetrics(prisma, { ...range, locationId: COUNTRY });
    expect(m).toMatchObject({ events: 3, escalated: 2 });
    expect(m.series.map((b) => [b.label, b.events, b.escalated])).toEqual([
      ["2026-10-12", 2, 2],
      ["2026-10-13", 0, 0],
      ["2026-10-14", 1, 0],
      ["2026-10-15", 0, 0],
      ["2026-10-16", 0, 0],
      ["2026-10-17", 0, 0],
      ["2026-10-18", 0, 0],
    ]);
    const everywhere = await computeEscalationMetrics(prisma, range);
    expect(everywhere.events).toBeGreaterThanOrEqual(4);
    expect(everywhere.escalated).toBeGreaterThanOrEqual(3);
  });
});
