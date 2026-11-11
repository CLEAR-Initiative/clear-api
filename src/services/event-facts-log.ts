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

/**
 * Write the facts the Event has now, as the result of `run`. Run it in the
 * same transaction as the write to the Event, after it.
 *
 * It writes no row when both are true: the run already has a row for the
 * Event, and the facts equal the last row of the same run kind. So each run
 * that writes an Event has one row for it at least, and a run that changes
 * nothing adds nothing more. A run is its kind and its `runId`; calls with
 * no `runId` count as one run.
 */
export function writeEventFacts(prisma: Pick<PrismaClient, "$executeRaw">, eventId: string, run: PipelineRun = {}) {
  const runKind = runKindOf(run);
  const runId = trimmed(run.runId);
  return prisma.$executeRaw`
    INSERT INTO "event_facts_log" (
      "event_id", "recorded_at", "started_at", "started_at_accuracy", "first_signal_created_at",
      "location_id", "location_district_id", "origin_id", "origin_district_id",
      "destination_id", "destination_district_id", "run_kind", "pipeline_version", "run_id"
    )
    SELECT f.*, ${runKind}::"LocationRunKind", ${trimmed(run.pipelineVersion)}, ${runId}
    FROM (
      SELECT e."id" AS "event_id", (now() AT TIME ZONE 'UTC') AS "recorded_at",
        e."started_at", e."started_at_accuracy", e."first_signal_created_at",
        e."location_id", ${districtOf("gl")} AS "location_district_id",
        e."origin_id", ${districtOf("ol")} AS "origin_district_id",
        e."destination_id", ${districtOf("dl")} AS "destination_district_id"
      FROM "events" e
      LEFT JOIN "locations" gl ON gl."id" = e."location_id"
      LEFT JOIN "locations" ol ON ol."id" = e."origin_id"
      LEFT JOIN "locations" dl ON dl."id" = e."destination_id"
      WHERE e."id" = ${eventId}
    ) f
    WHERE NOT (
      EXISTS (
        SELECT 1 FROM "event_facts_log" r
        WHERE r."event_id" = f."event_id" AND r."run_kind" = ${runKind}::"LocationRunKind"
          AND r."run_id" IS NOT DISTINCT FROM ${runId}
      )
      AND COALESCE((
        SELECT (p."started_at", p."started_at_accuracy", p."first_signal_created_at",
            p."location_id", p."location_district_id", p."origin_id", p."origin_district_id",
            p."destination_id", p."destination_district_id")
          IS NOT DISTINCT FROM
          (f."started_at", f."started_at_accuracy", f."first_signal_created_at",
            f."location_id", f."location_district_id", f."origin_id", f."origin_district_id",
            f."destination_id", f."destination_district_id")
        FROM "event_facts_log" p
        WHERE p."event_id" = f."event_id" AND p."run_kind" = ${runKind}::"LocationRunKind"
        ORDER BY p."id" DESC LIMIT 1
      ), false)
    )
  `;
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
