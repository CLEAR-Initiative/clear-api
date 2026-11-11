import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { districtOf } from "../../src/services/event-facts-log.js";

/**
 * The backfills of the migrations `20261111120000_signal_grouping_log` and
 * `20261111140000_event_facts_log`, for the Events in `eventIds`. A suite
 * seeds Events, Links and Alerts as they were before the logs, then calls
 * this. Its assertions from before the switch then show that the logs give
 * the series the live rows gave (ADR-0021).
 *
 * Each statement skips a row that already has its backfill, so a suite can
 * call it after every batch it seeds.
 */
export async function backfillHistory(prisma: PrismaClient, eventIds: string[]): Promise<void> {
  // One LIVE grouping log row per Link.
  await prisma.$executeRaw`
    INSERT INTO "signal_grouping_log" ("signal_id", "event_id", "linked_at", "run_kind")
    SELECT se."signal_id", se."event_id", se."collected_at", 'LIVE'
    FROM "signal_to_events" se
    WHERE se."event_id" = ANY(${eventIds}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM "signal_grouping_log" g WHERE g."signal_id" = se."signal_id" AND g."event_id" = se."event_id"
      )`;
  // One LIVE Event facts row per Event, with its current facts.
  await prisma.$executeRaw`
    INSERT INTO "event_facts_log" (
      "event_id", "recorded_at", "started_at", "started_at_accuracy", "first_signal_created_at",
      "location_id", "location_district_id", "origin_id", "origin_district_id",
      "destination_id", "destination_district_id", "run_kind"
    )
    SELECT e."id", (now() AT TIME ZONE 'UTC'), e."started_at", e."started_at_accuracy", e."first_signal_created_at",
      e."location_id", ${districtOf("gl")}, e."origin_id", ${districtOf("ol")}, e."destination_id", ${districtOf("dl")}, 'LIVE'
    FROM "events" e
    LEFT JOIN "locations" gl ON gl."id" = e."location_id"
    LEFT JOIN "locations" ol ON ol."id" = e."origin_id"
    LEFT JOIN "locations" dl ON dl."id" = e."destination_id"
    WHERE e."id" = ANY(${eventIds}::text[])
      AND NOT EXISTS (SELECT 1 FROM "event_facts_log" f WHERE f."event_id" = e."id")`;
  // The current onset onto each Alert.
  await prisma.$executeRaw`
    UPDATE "alerts" a
    SET "onset_at_raise" = e."started_at", "onset_accuracy_at_raise" = e."started_at_accuracy"
    FROM "events" e
    WHERE e."id" = a."event_id" AND e."id" = ANY(${eventIds}::text[])
      AND a."onset_at_raise" IS NULL AND a."onset_accuracy_at_raise" IS NULL`;
  // LIVE on every Event that holds a Signal a pipeline brought in.
  await prisma.$executeRaw`
    UPDATE "events" e
    SET "created_by_run_kind" = 'LIVE'
    WHERE e."id" = ANY(${eventIds}::text[])
      AND e."created_by_run_kind" IS NULL
      AND EXISTS (
        SELECT 1 FROM "signal_to_events" se
        JOIN "signals" s ON s."id" = se."signal_id"
        WHERE se."event_id" = e."id"
          AND s."submitted_by_id" IS NULL
          AND s."raw_data"->>'manual' IS DISTINCT FROM 'true'
      )`;
}

/** Remove the log rows of a suite's Events: they have no foreign key to the Event, so deleting the Event leaves them. */
export async function clearHistory(prisma: PrismaClient, eventIds: string[]): Promise<void> {
  await prisma.eventFacts.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.signalGroupingLinks.deleteMany({ where: { eventId: { in: eventIds } } });
}
