/**
 * Replay-safe history against the real schema (ADR-0021): the Event facts
 * log, the onset on the Alert, the run kind on Events and Alerts, and the
 * two views of the delay metrics. Every write goes through the mutations, as
 * a Live run, a Replay run and a person make it. Self-seeding and scoped to
 * its own locations and sources; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import { alertResolvers } from "../../src/resolvers/alert.resolver.js";
import type { Context } from "../../src/context.js";
import { computeMetricSeries, METRIC_KEYS, type MetricKey } from "../../src/services/metric-registry.js";
import { describeIfDb } from "../helpers/db.js";
import { clearHistory } from "../helpers/history-backfill.js";

const { createEvent, updateEvent, setEventAggregates } = eventResolvers.Mutation;
const { createAlert } = alertResolvers.Mutation;

const RUN = `rsh-db-${Date.now()}`;
const USER = `${RUN}-user`;
const FEED = `${RUN}-feed`;
/** One country with one district per test, so each test reads its own Events. */
const PLACES = ["facts", "alert", "onset", "replayEvent", "regroup"] as const;
const country = (place: (typeof PLACES)[number]) => `${RUN}-${place}-country`;
const district = (place: (typeof PLACES)[number]) => `${RUN}-${place}-district`;
let sourceId = "";
const eventIds: string[] = [];
let n = 0;

type Run = { runKind?: "LIVE" | "REPLAY"; pipelineVersion?: string; runId?: string };

/** The pipeline calls with an API key; a person has a session. */
const caller = (authMethod: "api-key" | "session") =>
  ({ prisma, user: { id: USER, role: "admin" }, session: null, authMethod }) as unknown as Context;
const pipeline = caller("api-key");
const person = caller("session");

const DAY1 = "2026-08-11T09:00:00Z";
const range = { from: "2026-08-10T00:00:00Z", to: "2026-08-23T23:59:59.999Z" };
/** After the range, so "now" never makes a bucket partial in one read and not in the next. */
const NOW = new Date("2026-09-15T00:00:00Z");

/** An ingested Signal with no Link. */
async function signal(place: (typeof PLACES)[number], iso = DAY1) {
  const s = await prisma.signals.create({
    data: {
      sourceId,
      externalId: `${RUN}-${n++}`,
      rawData: {},
      publishedAt: new Date(iso),
      collectedAt: new Date(iso),
      locationId: district(place),
    },
  });
  return s.id;
}

/** `createEvent`, as `context` calls it. No types: `createAlert` then raises an Alert without a disaster-type table. */
async function event(context: Context, place: (typeof PLACES)[number], signalIds: string[], opts: { onset?: string; at?: string } & Run = {}) {
  const { onset, at = DAY1, ...run } = opts;
  const e = await createEvent(
    null,
    {
      input: {
        signalIds,
        validFrom: at,
        firstSignalCreatedAt: at,
        lastSignalCreatedAt: at,
        startedAt: onset,
        startedAtAccuracy: onset ? "DAY" : undefined,
        types: [],
        rank: 0,
        locationId: district(place),
        ...run,
      },
    },
    context,
  );
  eventIds.push(e.id);
  return e.id;
}

const facts = (eventId: string) => prisma.eventFacts.findMany({ where: { eventId }, orderBy: { id: "asc" } });

/** One metric over the test's range and country, as [numerator, denominator] per bucket. */
async function series(metric: MetricKey, place: (typeof PLACES)[number], onsetBasis?: "AS_DELIVERED" | "CURRENT") {
  const m = await computeMetricSeries(prisma, { metric, ...range, locationId: country(place), granularity: "WEEK", onsetBasis }, NOW);
  return m.buckets.map((b) => [b.group, b.label, b.numerator, b.denominator]);
}

/** Every registry metric, as delivered. */
async function everyMetric(place: (typeof PLACES)[number]) {
  const out: Record<string, unknown> = {};
  for (const metric of METRIC_KEYS) out[metric] = await series(metric, place);
  return out;
}

describeIfDb("replay-safe history against the real schema", () => {
  beforeAll(async () => {
    for (const place of PLACES) {
      await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
        VALUES (${country(place)}, 'Testland', 0, ARRAY[]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
      await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (${district(place)}, 'Testville', 2, ${country(place)}, ARRAY[${country(place)}]::text[], ST_GeomFromText('POINT(0 0)', 4326))`;
    }
    await prisma.user.create({ data: { id: USER, name: "Admin", email: `${RUN}@example.org`, role: "admin" } });
    sourceId = (await prisma.dataSources.create({ data: { name: FEED, type: "test" } })).id;
  });

  afterAll(async () => {
    await clearHistory(prisma, eventIds);
    await prisma.alerts.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.signals.deleteMany({ where: { sourceId } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.locations.deleteMany({ where: { id: { in: PLACES.map(district) } } });
    await prisma.locations.deleteMany({ where: { id: { in: PLACES.map(country) } } });
  });

  it("writes an Event facts row when a pipeline run sets or changes a fact, and none for a person", async () => {
    const s = await signal("facts");
    const e = await event(pipeline, "facts", [s], { onset: "2026-08-10T00:00:00Z", runId: "run-1", pipelineVersion: "abc123" });
    expect((await facts(e)).map((r) => [r.runKind, r.runId, r.pipelineVersion, r.startedAt?.toISOString(), r.locationDistrictId])).toEqual([
      ["LIVE", "run-1", "abc123", "2026-08-10T00:00:00.000Z", district("facts")],
    ]);
    expect((await prisma.events.findUniqueOrThrow({ where: { id: e } })).createdByRunKind).toBe("LIVE");

    // The same run writes again and changes nothing: no row.
    await updateEvent(null, { id: e, input: { title: "A title", runId: "run-1" } }, pipeline);
    expect(await facts(e)).toHaveLength(1);

    // The same run changes the onset: a row.
    await updateEvent(null, { id: e, input: { startedAt: "2026-08-09T00:00:00Z", runId: "run-1" } }, pipeline);
    // A new run changes nothing: one row, so the run has its facts.
    await updateEvent(null, { id: e, input: { title: "Another title", runId: "run-2" } }, pipeline);
    await updateEvent(null, { id: e, input: { title: "A third title", runId: "run-2" } }, pipeline);
    // The recompute changes the accuracy: a row.
    const member = await prisma.signals.findUniqueOrThrow({ where: { id: s }, select: { id: true, revision: true } });
    await setEventAggregates(null, { id: e, input: { rank: 0, startedAtAccuracy: "WEEK" }, members: [member], runId: "run-2" }, pipeline);
    // A person changes the onset: no row.
    await updateEvent(null, { id: e, input: { startedAt: "2026-08-01T00:00:00Z" } }, person);
    // A replay writes the Event: a REPLAY row, and the kind that created the Event stays.
    await updateEvent(null, { id: e, input: { title: "From a replay", runKind: "REPLAY", runId: "replay-1" } }, pipeline);

    expect((await facts(e)).map((r) => [r.runKind, r.runId, r.startedAt?.toISOString().slice(0, 10), r.startedAtAccuracy])).toEqual([
      ["LIVE", "run-1", "2026-08-10", "DAY"],
      ["LIVE", "run-1", "2026-08-09", "DAY"],
      ["LIVE", "run-2", "2026-08-09", "DAY"],
      ["LIVE", "run-2", "2026-08-09", "WEEK"],
      ["REPLAY", "replay-1", "2026-08-01", "WEEK"],
    ]);
    expect((await prisma.events.findUniqueOrThrow({ where: { id: e } })).createdByRunKind).toBe("LIVE");

    // An Event that a person creates has no run kind and no row; one that a replay creates is REPLAY.
    const byPerson = await event(person, "facts", []);
    const byReplay = await event(pipeline, "facts", [], { runKind: "REPLAY" });
    expect(await facts(byPerson)).toEqual([]);
    expect((await prisma.events.findUniqueOrThrow({ where: { id: byPerson } })).createdByRunKind).toBeNull();
    expect((await prisma.events.findUniqueOrThrow({ where: { id: byReplay } })).createdByRunKind).toBe("REPLAY");
  });

  it("copies the onset onto the Alert when it is raised, and never changes it", async () => {
    const e = await event(pipeline, "alert", [await signal("alert")], { onset: "2026-08-11T00:00:00Z" });
    const alert = (await createAlert(null, { input: { eventId: e, status: "published" } }, pipeline))!;
    const raised = await prisma.alerts.findUniqueOrThrow({ where: { id: alert.id } });
    expect([raised.onsetAtRaise?.toISOString(), raised.onsetAccuracyAtRaise, raised.raisedByRunKind]).toEqual(["2026-08-11T00:00:00.000Z", "DAY", "LIVE"]);

    // The onset moves, and a retry asks for the Alert again with another status and as a replay.
    await updateEvent(null, { id: e, input: { startedAt: "2026-08-01T00:00:00Z" } }, pipeline);
    await createAlert(null, { input: { eventId: e, status: "archived", runKind: "REPLAY" } }, pipeline);
    const after = await prisma.alerts.findUniqueOrThrow({ where: { id: alert.id } });
    expect(after.status).toBe("archived");
    expect([after.onsetAtRaise, after.onsetAccuracyAtRaise, after.raisedByRunKind]).toEqual([raised.onsetAtRaise, "DAY", "LIVE"]);

    // An Alert that a person raises has the onset and no run kind.
    const other = await event(pipeline, "alert", [await signal("alert")], { onset: "2026-08-12T00:00:00Z" });
    const byPerson = (await createAlert(null, { input: { eventId: other } }, person))!;
    const row = await prisma.alerts.findUniqueOrThrow({ where: { id: byPerson.id } });
    expect([row.onsetAtRaise?.toISOString(), row.raisedByRunKind]).toEqual(["2026-08-12T00:00:00.000Z", null]);
  });

  it("keeps the As delivered series and moves the Same ruler series when a replay changes the onset", async () => {
    // Detected and alerted two days after the onset the Live run gave: not by next day.
    const at = "2026-08-13T09:00:00Z";
    const e = await event(pipeline, "onset", [await signal("onset", at)], { onset: "2026-08-11T00:00:00Z", at });
    const alert = (await createAlert(null, { input: { eventId: e, status: "published" } }, pipeline))!;
    await prisma.alerts.update({ where: { id: alert.id }, data: { createdAt: new Date("2026-08-13T10:00:00Z") } });

    const delays: MetricKey[] = ["DETECTED_BY_NEXT_DAY", "DETECTED_SAME_DAY", "ALERTED_BY_NEXT_DAY", "ALERTED_SAME_DAY"];
    const read = async (basis?: "AS_DELIVERED" | "CURRENT") => Object.fromEntries(await Promise.all(delays.map(async (m) => [m, await series(m, "onset", basis)])));
    const before = await read();
    expect(before.DETECTED_BY_NEXT_DAY).toEqual([[null, "2026-W33", 0, 1], [null, "2026-W34", 0, 0]]);
    expect(before.ALERTED_BY_NEXT_DAY).toEqual([[null, "2026-W33", 0, 1], [null, "2026-W34", 0, 0]]);
    // The two views agree while the onset is the one the Live run gave.
    expect(await read("CURRENT")).toEqual(before);

    // A replay reads the onset as the 13th: the same day as the Signal and the Alert.
    await updateEvent(null, { id: e, input: { startedAt: "2026-08-13T00:00:00Z", runKind: "REPLAY", runId: "replay-onset" } }, pipeline);

    expect(await read()).toEqual(before);
    expect(await read("AS_DELIVERED")).toEqual(before);
    const sameRuler = await read("CURRENT");
    for (const metric of delays) expect(sameRuler[metric]).toEqual([[null, "2026-W33", 1, 1], [null, "2026-W34", 0, 0]]);
  });

  it("refuses the Same ruler view for a metric that is not a delay metric", async () => {
    await expect(computeMetricSeries(prisma, { metric: "SIGNALS_GROUPED", onsetBasis: "CURRENT" })).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(computeMetricSeries(prisma, { metric: "DETECTED_SAME_DAY", onsetBasis: "LATEST" as never })).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(computeMetricSeries(prisma, { metric: "SIGNALS_GROUPED", onsetBasis: "AS_DELIVERED", ...range }, NOW)).resolves.toBeTruthy();
  });

  it("leaves an Event that a replay created out of every Event-based history series, also after a Live run adds a Signal", async () => {
    // History: one Event with one Signal, made by a Live run.
    const [a, b, c] = [await signal("replayEvent"), await signal("replayEvent"), await signal("replayEvent")];
    await event(pipeline, "replayEvent", [a], { onset: "2026-08-11T00:00:00Z" });
    const before = await everyMetric("replayEvent");
    expect(before.EVENTS_WITH_ONE_SIGNAL).toEqual([[null, "2026-W33", 1, 1], [null, "2026-W34", 0, 0]]);
    expect(before.SIGNALS_GROUPED).toEqual([[null, "2026-W33", 0, 1], [null, "2026-W34", 0, 0]]);

    // A replay makes a new Event of a and b, and raises an Alert for it.
    const made = await event(pipeline, "replayEvent", [a, b], { onset: "2026-08-11T00:00:00Z", runKind: "REPLAY", runId: "replay-2" });
    await createAlert(null, { input: { eventId: made, status: "published", runKind: "REPLAY" } }, pipeline);
    expect(await everyMetric("replayEvent")).toEqual(before);

    // The next day the drain adds c to that Event, as a Live run.
    await updateEvent(null, { id: made, input: { signalIds: [c], runId: "run-9" } }, pipeline);
    const after = await everyMetric("replayEvent");
    // c counts as grouped in its own bucket: the Event held a and b.
    expect(after.SIGNALS_GROUPED).toEqual([[null, "2026-W33", 1, 2], [null, "2026-W34", 0, 0]]);
    // No Event-based series has a new Event, and no series has the replay's Alert.
    expect({ ...after, SIGNALS_GROUPED: before.SIGNALS_GROUPED }).toEqual(before);
  });

  it("keeps the As delivered series of every metric when a replay re-groups the Signals of an alerted Event", async () => {
    const [a, b, c] = [await signal("regroup"), await signal("regroup"), await signal("regroup")];
    const first = await event(pipeline, "regroup", [a, b], { onset: "2026-08-10T00:00:00Z", runId: "run-1" });
    const second = await event(pipeline, "regroup", [c], { onset: "2026-08-11T00:00:00Z", runId: "run-1" });
    const alert = (await createAlert(null, { input: { eventId: first, status: "published" } }, pipeline))!;
    await prisma.alerts.update({ where: { id: alert.id }, data: { createdAt: new Date("2026-08-11T12:00:00Z") } });
    const before = await everyMetric("regroup");
    expect(before.SIGNALS_GROUPED).toEqual([[null, "2026-W33", 2, 3], [null, "2026-W34", 0, 0]]);
    expect(before.EVENTS_WITH_ONE_SIGNAL).toEqual([[null, "2026-W33", 1, 2], [null, "2026-W34", 0, 0]]);
    expect(before.DETECTED_BY_NEXT_DAY).toEqual([[null, "2026-W33", 2, 2], [null, "2026-W34", 0, 0]]);
    expect(before.ALERTED_BY_NEXT_DAY).toEqual([[null, "2026-W33", 1, 1], [null, "2026-W34", 0, 0]]);
    expect(before.EVENTS_ESCALATED).toEqual([[null, "2026-W33", 0, 2], [null, "2026-W34", 0, 0]]);

    // The replay moves every Link into the alerted Event and gives it a new onset. It deletes nothing.
    await prisma.signalEvents.deleteMany({ where: { eventId: second } });
    await updateEvent(null, { id: first, input: { signalIds: [c], startedAt: "2026-08-05T00:00:00Z", runKind: "REPLAY", runId: "regroup-1" } }, pipeline);

    expect(await everyMetric("regroup")).toEqual(before);
    // The Alert still holds the onset it was raised on.
    expect((await prisma.alerts.findUniqueOrThrow({ where: { id: alert.id } })).onsetAtRaise?.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });
});
