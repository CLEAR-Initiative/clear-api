/**
 * The computed ImpactPrior against the real schema (V4): which Events count
 * as history (same hazard, same country, began before, within the horizon,
 * not dummy) and which figure each contributes (the current Estimate).
 * Self-seeding; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeImpactPriors } from "../../src/services/computed-impact-prior.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `prior-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const DAY = 24 * 3600_000;
const eventIds: string[] = [];

async function event(opts: { types?: string[]; at: Date; locationId?: string; isDummy?: boolean }) {
  const row = await prisma.events.create({
    data: {
      types: opts.types ?? ["FL"],
      validTo: opts.at,
      firstSignalCreatedAt: opts.at,
      lastSignalCreatedAt: opts.at,
      startedAt: opts.at,
      rank: 0,
      locationId: opts.locationId ?? DISTRICT,
      isDummy: opts.isDummy ?? false,
    },
  });
  eventIds.push(row.id);
  return row.id;
}

async function figure(
  eventId: string,
  value: number,
  extra: { supersedesId?: string; estimatedAt?: Date; method?: "media_report" | "not_documented" | "model_inference" } = {},
) {
  return prisma.estimate.create({
    data: {
      eventId, metric: "people_displaced_new", value, method: extra.method ?? "media_report", attribution: "event_caused",
      validFor: new Date(), estimatedAt: extra.estimatedAt ?? new Date(), definitionVersion: "0.3.0",
      supersedesId: extra.supersedesId ?? null,
    },
  });
}

describeIfDb("computed ImpactPrior against the real schema", () => {
  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326)),
             (${ABROAD}, 'Elsewhere', 0, ARRAY[]::text[], ST_GeomFromText('POINT(1 1)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT}, 'Testville', 2, ${COUNTRY}, ARRAY[${COUNTRY}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
  });

  afterAll(async () => {
    // Superseding rows first: a superseded Estimate cannot be deleted.
    await prisma.estimate.deleteMany({ where: { eventId: { in: eventIds }, supersedesId: { not: null } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.locations.deleteMany({ where: { id: { in: [DISTRICT, COUNTRY, ABROAD] } } });
  });

  it("summarises the current figure of each earlier same-hazard Event in the country", async () => {
    const now = Date.now();
    const input = await event({ at: new Date(now) });
    const a = await event({ at: new Date(now - 400 * DAY) });
    const b = await event({ at: new Date(now - 800 * DAY), locationId: COUNTRY });
    const c = await event({ at: new Date(now - 30 * DAY) });
    await figure(a, 1000);
    // b's figure was corrected: only the correction counts.
    const old = await figure(b, 99_999, { estimatedAt: new Date(now - 10 * DAY) });
    await figure(b, 4000, { supersedesId: old.id });
    await figure(c, 2500);
    // Unobserved figures are not history: a's newer backfilled placeholder
    // must not mask its observed figure, and d (placeholder and model output
    // only) contributes nothing.
    await figure(a, 25_794, { method: "not_documented", estimatedAt: new Date(now + DAY) });
    const d = await event({ at: new Date(now - 60 * DAY) });
    await figure(d, 25_794, { method: "not_documented" });
    await figure(d, 2_000_000, { method: "model_inference" });
    // Not history: later than the input, another hazard, abroad, dummy, beyond the horizon.
    await figure(await event({ at: new Date(now + 5 * DAY) }), 1);
    await figure(await event({ at: new Date(now - 50 * DAY), types: ["EQ"] }), 1);
    await figure(await event({ at: new Date(now - 50 * DAY), locationId: ABROAD }), 1);
    await figure(await event({ at: new Date(now - 50 * DAY), isDummy: true }), 1);
    await figure(await event({ at: new Date(now - 12 * 365 * DAY) }), 1);
    await figure(input, 7);

    const [prior, ...rest] = await computeImpactPriors(prisma, input);
    expect(rest).toEqual([]);
    expect(prior).toMatchObject({
      hazardType: "FL",
      countryLocationId: COUNTRY,
      metric: "people_displaced_new",
      populationGroup: null,
      centralValue: 2500,
      lowerBound: 1000,
      upperBound: 4000,
      numberOfCases: 3,
      lowConfidence: false,
      basisMethods: [{ method: "media_report", count: 3 }],
    });
    expect([...prior.eventIds].sort()).toEqual([a, b, c].sort());

    // A shorter horizon drops the oldest case.
    const [short] = await computeImpactPriors(prisma, input, 2);
    expect(short).toMatchObject({ numberOfCases: 2, lowConfidence: true });
  });
});
