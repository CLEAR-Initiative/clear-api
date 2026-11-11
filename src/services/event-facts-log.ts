/**
 * The Event facts log (ADR-0021, decision 3). A row records the facts that
 * one pipeline run gave one Event: the onset and its accuracy, the first
 * Signal date, and the three places with the district of each. The log is
 * append-only: this module inserts rows, and nothing in clear-api updates or
 * deletes one. The history series of time to detection and "ACLED events
 * alerted nearby" read the last `LIVE` row of an Event, so a replay adds
 * `REPLAY` rows and changes no history.
 *
 * `createEvent`, `updateEvent` and `setEventAggregates` write the row, in the
 * same transaction as the write it records, for a call with an API key only:
 * the pipeline has a key, a person has a session. A person's edit writes no
 * row.
 *
 * A row from the drain is `LIVE`, also when the drain recomputes an Event:
 * facts mature while the Event is open. A replay job sends `REPLAY`.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { PipelineRun, RunKind } from "./signal-location-outcomes.js";

const trimmed = (value: string | null | undefined) => value?.trim() || null;

/** The run kind a pipeline call names; LIVE when it names none. */
export const runKindOf = (run: PipelineRun): RunKind => (run.runKind === "REPLAY" ? "REPLAY" : "LIVE");

/** The district of the location `alias`: the level-2 location among it and its ancestors. */
export function districtOf(alias: string): Prisma.Sql {
  return Prisma.raw(`CASE WHEN ${alias}."level" = 2 THEN ${alias}."id"
    ELSE (SELECT d."id" FROM "locations" d WHERE d."level" = 2 AND d."id" = ANY(${alias}."ancestor_ids") LIMIT 1) END`);
}

/** The facts of an Event that the log keeps. */
export interface EventFactValues {
  startedAt: Date | null;
  startedAtAccuracy: "DAY" | "WEEK" | "MONTH" | "YEAR" | null;
  firstSignalCreatedAt: Date;
  locationId: string | null;
  originId: string | null;
  destinationId: string | null;
}

/** The facts that one call set on the Event: true for each fact the call wrote. */
export type EventFactsSet = Partial<Record<keyof EventFactValues, boolean>>;

interface CurrentFacts extends EventFactValues {
  locationDistrictId: string | null;
  originDistrictId: string | null;
  destinationDistrictId: string | null;
}

const same = (a: Date | string | null, b: Date | string | null) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/**
 * Write the facts that `run` gave the Event. Run it in the same transaction
 * as the write to the Event, after it. `set` names the facts that the call
 * wrote; leave it out for a new Event, where the call wrote them all.
 *
 * - A `REPLAY` row holds the Event as the replay left it.
 * - A `LIVE` row holds what Live runs gave the Event. A fact that this call
 *   set takes the Event's value. A fact that this call did not set keeps the
 *   value of the Event's last `LIVE` row. So a fact that a replay or a
 *   person wrote never enters a `LIVE` row through a later Live write that
 *   did not set it. A call that sets a fact to the value the Event already
 *   has still sets it.
 *
 * It writes no row when both are true: the run already has a row for the
 * Event, and the facts equal the last row of the same run kind. So each run
 * that writes an Event has one row for it at least, and a run that changes
 * nothing adds nothing more. A run is its kind and its `runId`; calls with
 * no `runId` count as one run.
 */
export async function writeEventFacts(
  prisma: Pick<PrismaClient, "$queryRaw" | "eventFacts">,
  eventId: string,
  run: PipelineRun = {},
  set: EventFactsSet | null = null,
): Promise<void> {
  const runKind = runKindOf(run);
  const runId = trimmed(run.runId);
  const [now] = await prisma.$queryRaw<CurrentFacts[]>`
    SELECT e."started_at" AS "startedAt", e."started_at_accuracy" AS "startedAtAccuracy",
      e."first_signal_created_at" AS "firstSignalCreatedAt",
      e."location_id" AS "locationId", ${districtOf("gl")} AS "locationDistrictId",
      e."origin_id" AS "originId", ${districtOf("ol")} AS "originDistrictId",
      e."destination_id" AS "destinationId", ${districtOf("dl")} AS "destinationDistrictId"
    FROM "events" e
    LEFT JOIN "locations" gl ON gl."id" = e."location_id"
    LEFT JOIN "locations" ol ON ol."id" = e."origin_id"
    LEFT JOIN "locations" dl ON dl."id" = e."destination_id"
    WHERE e."id" = ${eventId}
  `;
  if (!now) return;
  const last = await prisma.eventFacts.findFirst({ where: { eventId, runKind }, orderBy: { id: "desc" } });

  const facts: CurrentFacts = { ...now };
  if (runKind === "LIVE" && last && set) {
    if (!set.startedAt) facts.startedAt = last.startedAt;
    if (!set.startedAtAccuracy) facts.startedAtAccuracy = last.startedAtAccuracy;
    if (!set.firstSignalCreatedAt) facts.firstSignalCreatedAt = last.firstSignalCreatedAt;
    // A place and its district go together.
    if (!set.locationId) {
      facts.locationId = last.locationId;
      facts.locationDistrictId = last.locationDistrictId;
    }
    if (!set.originId) {
      facts.originId = last.originId;
      facts.originDistrictId = last.originDistrictId;
    }
    if (!set.destinationId) {
      facts.destinationId = last.destinationId;
      facts.destinationDistrictId = last.destinationDistrictId;
    }
  }

  const unchanged =
    last !== null &&
    same(facts.startedAt, last.startedAt) &&
    same(facts.startedAtAccuracy, last.startedAtAccuracy) &&
    same(facts.firstSignalCreatedAt, last.firstSignalCreatedAt) &&
    same(facts.locationId, last.locationId) &&
    same(facts.locationDistrictId, last.locationDistrictId) &&
    same(facts.originId, last.originId) &&
    same(facts.originDistrictId, last.originDistrictId) &&
    same(facts.destinationId, last.destinationId) &&
    same(facts.destinationDistrictId, last.destinationDistrictId);
  if (unchanged && (await prisma.eventFacts.findFirst({ where: { eventId, runKind, runId }, select: { id: true } }))) return;

  await prisma.eventFacts.create({
    data: { eventId, recordedAt: new Date(), ...facts, runKind, pipelineVersion: trimmed(run.pipelineVersion), runId },
  });
}

/**
 * The last `LIVE` row of each Event: what the Live run last said about it.
 * A table expression for a `WITH` clause or a join.
 */
export const LIVE_EVENT_FACTS: Prisma.Sql = Prisma.raw(`(
    SELECT DISTINCT ON (f."event_id") f.*
    FROM "event_facts_log" f
    WHERE f."run_kind" = 'LIVE'
    ORDER BY f."event_id", f."id" DESC
  )`);

/**
 * True when the Event `alias` is part of a history series: a Replay run did
 * not create it (ADR-0021, decision 6). An Event that a person created has
 * no run kind and stays in.
 */
export function historyEvent(alias: string): Prisma.Sql {
  return Prisma.raw(`${alias}."created_by_run_kind" IS DISTINCT FROM 'REPLAY'`);
}

/**
 * The onset fields of a new Alert: the Event's onset and its accuracy at the
 * instant the Alert is raised (ADR-0021, decision 3). No mutation changes
 * them afterwards.
 */
export function onsetAtRaise(event: { startedAt: Date | null; startedAtAccuracy: "DAY" | "WEEK" | "MONTH" | "YEAR" | null }) {
  return { onsetAtRaise: event.startedAt, onsetAccuracyAtRaise: event.startedAtAccuracy };
}
