/**
 * The Outcome log (ADR-0020). An Outcome records where one pipeline run
 * placed one Signal. The log is append-only: this module inserts rows, and
 * nothing in clear-api updates or deletes one. Location precision reads the
 * log (`location-precision-metrics.ts`), so a replay adds rows and changes no
 * history.
 *
 * Two writes exist:
 *
 * - `arrivalOutcome`: `createSignal` writes the location the Signal arrived
 *   with, in the same write as the Signal.
 * - `writeProcessedOutcomes`: `markSignalsProcessed` writes the location
 *   the Signal has when a run finishes it, in the same transaction as
 *   `processedAt`. A run that found no location writes a row with no location.
 *
 * `updateSignalLocation` and `updateSignalContent` set a location during a
 * run. They write no Outcome: the run's result is recorded once, when the run
 * marks the Signal.
 *
 * Only Signals a pipeline brought in get Outcomes (no `submittedById`,
 * `rawData.manual` not true). A person's correction writes none.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

export const RUN_KINDS = ["LIVE", "REPLAY"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** What the pipeline says about the run that places a Signal. */
export interface PipelineRun {
  /** Defaults to LIVE. clear-api records REPLAY anyway when a run already finished the Signal. */
  runKind?: RunKind | null;
  /** The clear-pipeline git SHA. */
  pipelineVersion?: string | null;
  /** The Dagster run id. */
  runId?: string | null;
}

/**
 * The location the pipeline gave the Signal `alias`: its own location fields
 * (general, else origin, else destination), or, once a person corrected it,
 * the location the first correction overwrote.
 */
export function pipelineLocation(alias: string): Prisma.Sql {
  return Prisma.raw(`CASE
    WHEN ${alias}."location_corrected_at" IS NULL THEN COALESCE(${alias}."location_id", ${alias}."origin_id", ${alias}."destination_id")
    ELSE ${alias}."pipeline_location_id"
  END`);
}

/** True when a pipeline brought the Signal `alias` in; only these get Outcomes. */
function pipelineSignal(alias: string): Prisma.Sql {
  return Prisma.raw(`${alias}."submitted_by_id" IS NULL AND ${alias}."raw_data"->>'manual' IS DISTINCT FROM 'true'`);
}

const trimmed = (value: string | null | undefined) => value?.trim() || null;

/**
 * The nested create for the Outcome of a new Signal: the location it arrived
 * with (null for none), at `collectedAt`. A new Signal is always a Live run.
 */
export async function arrivalOutcome(
  prisma: Pick<PrismaClient, "locations">,
  signal: { collectedAt: Date; locationId?: string | null; originId?: string | null; destinationId?: string | null },
  run: PipelineRun,
) {
  const locationId = signal.locationId ?? signal.originId ?? signal.destinationId ?? null;
  const location = locationId
    ? await prisma.locations.findUnique({ where: { id: locationId }, select: { level: true } })
    : null;
  return {
    locatedAt: signal.collectedAt,
    locationId,
    level: location?.level ?? null,
    runKind: "LIVE" as const,
    step: "ARRIVAL" as const,
    pipelineVersion: trimmed(run.pipelineVersion),
    runId: trimmed(run.runId),
  };
}

/**
 * Write one Outcome for each Signal in `ids` that this call just marked: the
 * location the Signal has now, at its new `processedAt`. Run it in the same
 * transaction as the update that marks the Signals, after it. A Signal the
 * update skipped (compare-and-set) does not carry this call's `processedAt`
 * and `status`, so it gets no row.
 *
 * The Outcome is REPLAY when the pipeline says so, or when a run already
 * finished this Signal (it has a `PROCESSED` Outcome): a second placement is
 * a replay, whatever caused it (a content revision, a requeue, a replay job).
 */
export function writeProcessedOutcomes(
  prisma: Pick<PrismaClient, "$executeRaw">,
  ids: string[],
  status: "PROCESSED" | "FAILED",
  processedAt: Date,
  run: PipelineRun = {},
) {
  const requested: RunKind = run.runKind === "REPLAY" ? "REPLAY" : "LIVE";
  // Compared as a UTC instant, so the session time zone cannot shift it.
  const markedAt = Prisma.sql`(${processedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  return prisma.$executeRaw`
    INSERT INTO "signal_location_outcomes"
      ("signal_id", "located_at", "location_id", "level", "run_kind", "step", "pipeline_version", "run_id")
    SELECT s."id", s."processed_at", l."id", l."level",
      CASE
        WHEN ${requested} = 'REPLAY' OR EXISTS (
          SELECT 1 FROM "signal_location_outcomes" o
          WHERE o."signal_id" = s."id" AND o."step" = 'PROCESSED'
        ) THEN 'REPLAY'
        ELSE 'LIVE'
      END::"LocationRunKind",
      'PROCESSED',
      ${trimmed(run.pipelineVersion)},
      ${trimmed(run.runId)}
    FROM "signals" s
    LEFT JOIN "locations" l ON l."id" = ${pipelineLocation("s")}
    WHERE s."id" = ANY(${[...new Set(ids)]}::text[])
      AND s."processed_at" = ${markedAt}
      AND s."status" = ${status}::"SignalStatus"
      AND ${pipelineSignal("s")}
  `;
}
