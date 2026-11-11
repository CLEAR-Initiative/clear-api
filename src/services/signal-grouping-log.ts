/**
 * The grouping log (ADR-0021). A row records one Link that a pipeline run
 * made between a Signal and an Event. The log is append-only: this module
 * inserts rows, and nothing in clear-api updates or deletes one. The grouping
 * metrics read the `LIVE` rows (`grouping-metrics.ts`), so a re-grouping
 * replay adds `REPLAY` rows and changes no history.
 *
 * `createEvent` and `updateEvent` (with `signalIds`) write the rows, in the
 * same transaction as the Links. They write only for a call with an API key:
 * the pipeline has a key, a person has a session. So a Link that a person
 * makes (the dashboard, an accepted web case) writes no row.
 *
 * The run kind is what the pipeline sends, with LIVE as the default. The
 * Outcome log (ADR-0020) reads a second placement as a replay; this log does
 * not, because the drain adds Signals to an Event for as long as the Event
 * is open, and each of those Links is a Live result.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { PipelineRun, RunKind } from "./signal-location-outcomes.js";

const trimmed = (value: string | null | undefined) => value?.trim() || null;

/**
 * Write one row for each Link of `eventId` to a Signal in `signalIds`, at the
 * instant of the Link (`signal_to_events.collected_at`). Run it in the same
 * transaction as the insert of the Links, after it, and only with the Links
 * that this call made.
 */
export function writeGroupingLinks(
  prisma: Pick<PrismaClient, "$executeRaw">,
  eventId: string,
  signalIds: string[],
  run: PipelineRun = {},
) {
  const runKind: RunKind = run.runKind === "REPLAY" ? "REPLAY" : "LIVE";
  return prisma.$executeRaw`
    INSERT INTO "signal_grouping_log"
      ("signal_id", "event_id", "linked_at", "run_kind", "pipeline_version", "run_id")
    SELECT se."signal_id", se."event_id", se."collected_at", ${runKind}::"LocationRunKind",
      ${trimmed(run.pipelineVersion)}, ${trimmed(run.runId)}
    FROM "signal_to_events" se
    WHERE se."event_id" = ${eventId}
      AND se."signal_id" = ANY(${[...new Set(signalIds)]}::text[])
  `;
}

/**
 * True when the Signal `alias` has a `LIVE` row: a Live run put it in an
 * Event. The history series count these Signals.
 */
export function hasLiveLink(alias: string): Prisma.Sql {
  return Prisma.raw(
    `EXISTS (SELECT 1 FROM "signal_grouping_log" g0 WHERE g0."signal_id" = ${alias}."id" AND g0."run_kind" = 'LIVE')`,
  );
}
