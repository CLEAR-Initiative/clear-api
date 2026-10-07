/**
 * The ImpactPrior computed from accepted history (ADR-0010 amendment, V4).
 *
 * The Domain Ontology's ImpactPrior is "what has typically happened before,
 * given a hazard type, a context and a population" — a lookup with honest
 * uncertainty, inferred from historical Events. Now that accepted web cases
 * become Events with Estimates, the prior is computed from that history
 * instead of proposed and reviewed: for an Event, take the Events before it
 * that manifest the same hazard in the same country within the horizon,
 * take each one's current figure per metric and population group, and
 * summarise them — median as the central value, the range as the bounds,
 * and the number of Events it rests on, so a prior resting on three Events
 * never looks like one resting on ninety.
 *
 * Computed on read, so it is always current with what analysts have
 * accepted; nothing is stored, so nothing needs superseding. No human
 * decision: every Event and figure it rests on was already accepted or
 * ingested. Applying a prior from one context to another is not done here.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { resolveEventCountryId } from "../utils/event-country.js";

export const COMPUTED_PRIOR_METHOD_VERSION = "clear-impact-prior@0.2.0";
export const DEFAULT_PRIOR_HORIZON_YEARS = 10;
/** Below this many Events a prior is still returned, flagged low-confidence. */
export const MIN_CONFIDENT_CASES = 3;

export interface ComputedImpactPrior {
  hazardType: string;
  countryLocationId: string;
  horizonYears: number;
  metric: string;
  populationGroup: string | null;
  /** The figures' unit; null when they state none (people, by the metric). */
  unit: string | null;
  centralValue: number;
  lowerBound: number;
  upperBound: number;
  numberOfCases: number;
  lowConfidence: boolean;
  /** The historical Events it rests on. */
  eventIds: string[];
  /** The Estimates it rests on, one per Event. */
  estimateIds: string[];
  methodVersion: string;
}

interface FigureRow {
  event_id: string;
  estimate_id: string;
  metric: string;
  population_group: string | null;
  unit: string | null;
  value: number;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Summarise one figure per historical Event into priors, one per (metric,
 * population group, unit) — figures in different units are never averaged
 * together. Pure, so the arithmetic is tested without a database.
 */
export function summarisePriors(
  rows: FigureRow[],
  context: { hazardType: string; countryLocationId: string; horizonYears: number },
): ComputedImpactPrior[] {
  const groups = new Map<string, FigureRow[]>();
  for (const r of rows) {
    const key = `${r.metric}\u0000${r.population_group ?? ""}\u0000${r.unit ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const priors: ComputedImpactPrior[] = [];
  for (const list of groups.values()) {
    const values = list.map((r) => Number(r.value)).sort((a, b) => a - b);
    priors.push({
      ...context,
      metric: list[0].metric,
      populationGroup: list[0].population_group,
      unit: list[0].unit,
      centralValue: median(values),
      lowerBound: values[0],
      upperBound: values[values.length - 1],
      numberOfCases: list.length,
      lowConfidence: list.length < MIN_CONFIDENT_CASES,
      eventIds: list.map((r) => r.event_id),
      estimateIds: list.map((r) => r.estimate_id),
      methodVersion: COMPUTED_PRIOR_METHOD_VERSION,
    });
  }
  // Most evidence first, then by metric for a stable order.
  return priors.sort((a, b) => b.numberOfCases - a.numberOfCases || a.metric.localeCompare(b.metric));
}

/**
 * The priors for an Event, one per hazard it manifests × metric × population
 * group with any history. An Event without a resolvable country or onset
 * has no context to compare against, so it gets none.
 */
export async function computeImpactPriors(
  prisma: PrismaClient | Prisma.TransactionClient,
  eventId: string,
  horizonYears: number = DEFAULT_PRIOR_HORIZON_YEARS,
): Promise<ComputedImpactPrior[]> {
  const event = await prisma.events.findUnique({
    where: { id: eventId },
    select: {
      id: true, types: true, startedAt: true, firstSignalCreatedAt: true,
      locationId: true, originId: true, destinationId: true,
    },
  });
  if (!event || event.types.length === 0) return [];
  const countryId = await resolveEventCountryId(prisma, event);
  if (!countryId) return [];
  const start = event.startedAt ?? event.firstSignalCreatedAt;
  const from = new Date(start);
  from.setUTCFullYear(from.getUTCFullYear() - horizonYears);

  const priors: ComputedImpactPrior[] = [];
  for (const hazardType of event.types) {
    // One current figure per (historical Event, metric, population group):
    // the newest Estimate nothing supersedes. History is Events that began
    // before this one (onset, else first Signal), in the same country, with
    // the same hazard.
    const rows = await prisma.$queryRaw<FigureRow[]>`
      SELECT DISTINCT ON (es."event_id", es."metric", es."population_group", NULLIF(lower(btrim(es."unit")), ''))
             es."event_id", es."id" AS estimate_id, es."metric"::text AS metric,
             es."population_group", NULLIF(lower(btrim(es."unit")), '') AS unit, es."value"
      FROM "estimates" es
      JOIN "events" e ON e."id" = es."event_id"
      JOIN "locations" l ON l."id" = COALESCE(e."location_id", e."origin_id", e."destination_id")
      WHERE e."id" <> ${event.id}
        AND NOT e."isDummy"
        AND ${hazardType} = ANY(e."types")
        AND (l."id" = ${countryId} OR ${countryId} = ANY(l."ancestor_ids"))
        AND COALESCE(e."started_at", e."first_signal_created_at") >= (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND COALESCE(e."started_at", e."first_signal_created_at") <  (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND NOT EXISTS (SELECT 1 FROM "estimates" s2 WHERE s2."supersedes_id" = es."id")
      ORDER BY es."event_id", es."metric", es."population_group", NULLIF(lower(btrim(es."unit")), ''),
               es."estimated_at" DESC, es."id" DESC`;
    priors.push(...summarisePriors(rows, { hazardType, countryLocationId: countryId, horizonYears }));
  }
  return priors;
}
