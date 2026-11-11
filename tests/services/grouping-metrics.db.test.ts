/**
 * Grouping proxies against the real schema (ADR-0018): which Signals count
 * as grouped (an Event with another ingested Signal), which Events hold one
 * ingested Signal, the source each is read under, and the location and
 * source filters. Self-seeding and scoped to its own locations and sources;
 * run with `bun run test:db`.
 *
 * Both proxies read the grouping log (ADR-0021). The first test seeds Links
 * as they were before the log, then writes the rows the backfill migration
 * writes. Its assertions are the ones from before the switch, so they show
 * that the log gives the series the Links gave. The other tests make Links
 * through `createEvent` and `updateEvent`, as a Live run, a Replay run and a
 * person do.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeSignalsGrouped, computeSingleSignalEvents } from "../../src/services/grouping-metrics.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { createEvent, updateEvent } = eventResolvers.Mutation;

const RUN = `grp-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const DISTRICT = `${RUN}-district`;
const ABROAD = `${RUN}-abroad`;
const USER = `${RUN}-user`;
const X = `${RUN}-x`;
const DM = `${RUN}-dm`;
/** One source per test below the first, so each reads its own Signals. */
const SOURCES = ["live", "replay", "retract", "late", "regroup", "person"].map((s) => `${RUN}-${s}`);
const [LIVE, REPLAY, RETRACT, LATE, REGROUP, PERSON] = SOURCES as [string, string, string, string, string, string];
const sourceIds: Record<string, string> = {};
const eventIds: string[] = [];
let n = 0;

const at = (iso: string) => new Date(iso);

/** The pipeline calls with an API key; a person has a session. */
const caller = (authMethod: "api-key" | "session") =>
  ({ prisma, user: { id: USER, role: "admin" }, session: null, authMethod }) as unknown as Context;
const pipeline = caller("api-key");
const person = caller("session");

/**
 * The backfill of the migration `20261111120000_signal_grouping_log`, for
 * this suite's Events: one LIVE row per Link that has none, at the instant
 * of the Link.
 */
const backfill = () => prisma.$executeRaw`
  INSERT INTO "signal_grouping_log" ("signal_id", "event_id", "linked_at", "run_kind")
  SELECT se."signal_id", se."event_id", se."collected_at", 'LIVE'
  FROM "signal_to_events" se
  WHERE se."event_id" = ANY(${eventIds}::text[])
    AND NOT EXISTS (
      SELECT 1 FROM "signal_grouping_log" g WHERE g."signal_id" = se."signal_id" AND g."event_id" = se."event_id"
    )`;

/** An ingested Signal with no Link. */
async function signal(source: string, iso: string, opts: { manual?: boolean } = {}) {
  const s = await prisma.signals.create({
    data: {
      sourceId: sourceIds[source]!,
      externalId: `${RUN}-${n++}`,
      rawData: opts.manual ? { manual: true, createdBy: USER } : {},
      publishedAt: at(iso),
      collectedAt: at(iso),
      locationId: DISTRICT,
    },
  });
  return s.id;
}

type Run = { runKind?: "LIVE" | "REPLAY"; pipelineVersion?: string; runId?: string };

/** `createEvent` with `signalIds`, as `context` calls it. */
async function group(context: Context, signalIds: string[], iso: string, run: Run = {}) {
  const e = await createEvent(null, {
    input: { signalIds, validFrom: iso, firstSignalCreatedAt: iso, lastSignalCreatedAt: iso, types: ["FL"], rank: 0, locationId: DISTRICT, ...run },
  }, context);
  eventIds.push(e.id);
  return e.id;
}

/** `updateEvent` with `signalIds`, as `context` calls it. */
const join = (context: Context, eventId: string, signalIds: string[], run: Run = {}) =>
  updateEvent(null, { id: eventId, input: { signalIds, ...run } }, context);

const logOf = (signalIds: string[]) =>
  prisma.signalGroupingLinks.findMany({ where: { signalId: { in: signalIds } }, orderBy: { id: "asc" } });

/** One week of one source: [numerator, denominator] of both proxies. */
async function week(source: string, from: string, to: string) {
  const input = { from, to, sourceNames: [source], granularity: "WEEK" as const };
  const grouped = (await computeSignalsGrouped(prisma, input)).bySource[0];
  const single = (await computeSingleSignalEvents(prisma, input)).bySource[0];
  return {
    grouped: grouped ? [grouped.numerator, grouped.denominator] : [0, 0],
    single: single ? [single.numerator, single.denominator] : [0, 0],
  };
}

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
    for (const name of [X, DM, ...SOURCES]) {
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
    const shared = await event({ firstSignalAt: "2026-10-12T09:00:00Z", signals: [{ source: X, at: "2026-10-12T09:00:00Z" }, { source: DM, at: "2026-10-12T10:00:00Z" }] });
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
    // Abroad: out of the country's scope for both metrics; X first, DM half an hour later.
    await event({ firstSignalAt: "2026-10-16T09:00:00Z", locationId: ABROAD, signals: [{ source: X, at: "2026-10-16T09:00:00Z", locationId: ABROAD }, { source: DM, at: "2026-10-16T09:30:00Z", locationId: ABROAD }] });
    // Before the range.
    await event({ firstSignalAt: "2026-10-05T09:00:00Z", signals: [{ source: X, at: "2026-10-05T09:00:00Z" }, { source: DM, at: "2026-10-05T09:00:00Z" }] });
    // An ingested Signal not yet linked to any Event: not through grouping, so not in the denominator.
    await prisma.signals.create({
      data: { sourceId: sourceIds[X]!, externalId: `${RUN}-${n++}`, rawData: {}, publishedAt: at("2026-10-13T12:00:00Z"), collectedAt: at("2026-10-13T12:00:00Z"), locationId: DISTRICT },
    });
    // A Signal linked to two Events, its own and the first: counted once, grouped through the first; its own
    // Event holds exactly one ingested Signal, under X.
    const own = await event({ firstSignalAt: "2026-10-14T12:00:00Z", signals: [] });
    await prisma.signals.create({
      data: {
        sourceId: sourceIds[X]!,
        externalId: `${RUN}-${n++}`,
        rawData: {},
        publishedAt: at("2026-10-14T12:00:00Z"),
        collectedAt: at("2026-10-14T12:00:00Z"),
        locationId: DISTRICT,
        signalEvents: { create: [{ eventId: shared, collectedAt: at("2026-10-14T12:00:00Z") }, { eventId: own, collectedAt: at("2026-10-14T12:00:00Z") }] },
      },
    });

    await backfill();

    const input = { from: "2026-10-12T00:00:00Z", to: "2026-10-18T23:59:59.999Z", locationId: COUNTRY, sourceNames: [X, DM], granularity: "WEEK" as const };
    const grouped = await computeSignalsGrouped(prisma, input);
    expect(grouped.bySource).toEqual([
      { source: X, numerator: 2, denominator: 4 },
      { source: DM, numerator: 1, denominator: 2 },
    ]);
    expect(grouped.series.map((r) => [r.source, r.label, r.numerator, r.denominator])).toEqual([
      [X, "2026-W42", 2, 4],
      [DM, "2026-W42", 1, 2],
    ]);

    const single = await computeSingleSignalEvents(prisma, input);
    expect(single.bySource).toEqual([
      { source: X, numerator: 3, denominator: 4 },
      { source: DM, numerator: 1, denominator: 1 },
    ]);

    // Without the location, the Event abroad joins both reads.
    expect((await computeSignalsGrouped(prisma, { ...input, locationId: null })).bySource).toEqual([
      { source: X, numerator: 3, denominator: 5 },
      { source: DM, numerator: 2, denominator: 3 },
    ]);
    expect((await computeSingleSignalEvents(prisma, { ...input, locationId: null, sourceNames: [X] })).bySource).toEqual([{ source: X, numerator: 3, denominator: 5 }]);
  });
  const FROM = "2026-09-07T00:00:00Z";
  const TO = "2026-09-13T23:59:59.999Z";
  const DAY1 = "2026-09-08T09:00:00Z";

  it("writes one LIVE row per Link that the pipeline makes, with the run", async () => {
    const [a, b, c] = [await signal(LIVE, DAY1), await signal(LIVE, DAY1), await signal(LIVE, DAY1)];
    const e = await group(pipeline, [a, b, a], DAY1, { pipelineVersion: " abc123 ", runId: "run-1" });
    await join(pipeline, e, [b, c]);

    const rows = await logOf([a, b, c]);
    expect(rows.map((r) => [r.signalId, r.eventId, r.runKind, r.pipelineVersion, r.runId])).toEqual([
      [a, e, "LIVE", "abc123", "run-1"],
      [b, e, "LIVE", "abc123", "run-1"],
      [c, e, "LIVE", null, null],
    ]);
    const links = await prisma.signalEvents.findMany({ where: { eventId: e } });
    for (const row of rows) {
      expect(row.linkedAt).toEqual(links.find((l) => l.signalId === row.signalId)!.collectedAt);
    }
    expect(await week(LIVE, FROM, TO)).toEqual({ grouped: [3, 3], single: [0, 1] });
  });

  it("counts a Signal that a Live run adds to an Event of a replay as grouped", async () => {
    const [a, b, c] = [await signal(REPLAY, DAY1), await signal(REPLAY, DAY1), await signal(REPLAY, DAY1)];
    const e = await group(pipeline, [a, b], DAY1, { runKind: "REPLAY", runId: "replay-1" });
    // The replay's Links are not history: no Signal has a LIVE row yet.
    expect(await week(REPLAY, FROM, TO)).toEqual({ grouped: [0, 0], single: [0, 0] });

    await join(pipeline, e, [c]);
    expect((await logOf([a, b, c])).map((r) => r.runKind)).toEqual(["REPLAY", "REPLAY", "LIVE"]);
    // c is grouped: the Event held a and b when the Live run linked it.
    expect((await week(REPLAY, FROM, TO)).grouped).toEqual([1, 1]);
  });

  it("stops counting a Signal as grouped when its only companion is retracted", async () => {
    const [a, b] = [await signal(RETRACT, DAY1), await signal(RETRACT, DAY1)];
    await group(pipeline, [a, b], DAY1);
    expect(await week(RETRACT, FROM, TO)).toEqual({ grouped: [2, 2], single: [0, 1] });

    await prisma.signals.update({ where: { id: a }, data: { retracted: true } });
    expect(await week(RETRACT, FROM, TO)).toEqual({ grouped: [0, 1], single: [1, 1] });
  });

  it("gives no company to a Signal that was alone when a replay adds a Signal later", async () => {
    const [a, b] = [await signal(LATE, DAY1), await signal(LATE, DAY1)];
    const e = await group(pipeline, [a], DAY1);
    const before = await week(LATE, FROM, TO);
    expect(before).toEqual({ grouped: [0, 1], single: [1, 1] });

    await join(pipeline, e, [b], { runKind: "REPLAY" });
    expect(await week(LATE, FROM, TO)).toEqual(before);
  });

  it("keeps both series when a replay re-groups the Signals", async () => {
    const [a, b, c] = [await signal(REGROUP, DAY1), await signal(REGROUP, DAY1), await signal(REGROUP, DAY1)];
    const first = await group(pipeline, [a, b], DAY1);
    const second = await group(pipeline, [c], DAY1);
    const before = await week(REGROUP, FROM, TO);
    expect(before).toEqual({ grouped: [2, 3], single: [1, 2] });
    const liveRows = await logOf([a, b, c]);

    // The replay moves every Link to one new Event.
    await prisma.signalEvents.deleteMany({ where: { eventId: { in: [first, second] } } });
    await group(pipeline, [a, b, c], DAY1, { runKind: "REPLAY", runId: "regroup-1" });

    expect(await week(REGROUP, FROM, TO)).toEqual(before);
    // The replay added rows and changed none.
    const after = await logOf([a, b, c]);
    expect(after.slice(0, liveRows.length)).toEqual(liveRows);
    expect(after.slice(liveRows.length).map((r) => [r.runKind, r.runId])).toEqual([
      ["REPLAY", "regroup-1"],
      ["REPLAY", "regroup-1"],
      ["REPLAY", "regroup-1"],
    ]);
  });

  it("writes no row for a Link that a person makes", async () => {
    const [a, b, c] = [await signal(PERSON, DAY1), await signal(PERSON, DAY1), await signal(PERSON, DAY1)];
    const e = await group(person, [a, b], DAY1);
    await join(person, e, [c]);

    expect(await prisma.signalEvents.count({ where: { eventId: e } })).toBe(3);
    expect(await logOf([a, b, c])).toEqual([]);
    expect(await week(PERSON, FROM, TO)).toEqual({ grouped: [0, 0], single: [0, 0] });
  });
});
