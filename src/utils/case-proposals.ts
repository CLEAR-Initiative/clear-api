/**
 * CaseProposals (ADR-0010 amendment, V4): one historical case a web Worker
 * found while enriching an Event, decided by an analyst on its own.
 *
 * The checks here need no database. The ones that do — the hazard is one of
 * the requesting Event's types, a location or matched Event exists and sits
 * in the Event's country — run in `completeTask`.
 */

import { GraphQLError } from "graphql";
import type { Prisma } from "../generated/prisma/client.js";

/** The Domain Ontology's seven metric types: figures the sector routinely
 *  conflates, kept apart. A case's figure names exactly one. */
export const METRIC_TYPES: ReadonlySet<string> = new Set([
  "people_affected",
  "people_displaced_new",
  "people_displaced_cumulative",
  "people_in_need",
  "people_targeted",
  "people_reached",
  "households_affected",
]);

export const CASE_GEOGRAPHIC_SCOPES: ReadonlySet<string> = new Set(["district", "country"]);

/** Cases per completion. A web Worker cites a handful; a runaway one must
 *  not flood the Inbox. */
export const MAX_CASES_PER_TASK = 50;
const MAX_URL_LENGTH = 2048;
const MAX_QUOTE_LENGTH = 4000;
const MAX_LABEL_LENGTH = 500;
const MAX_FIGURES_PER_CASE = 20;
/** A case is something that already happened; allow a day of clock and
 *  time-zone slack before calling its date the future. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export interface CaseFigureInput {
  metric: string;
  value: number;
  lowerBound?: number | null;
  upperBound?: number | null;
  unit?: string | null;
  populationGroup?: string | null;
}

export interface CaseProposalInput {
  sourceUrl: string;
  quote: string;
  occurredAt: Date;
  locationLabel: string;
  locationId?: string | null;
  hazardType: string;
  geographicScope: string;
  figures?: CaseFigureInput[] | null;
  matchedEventId?: string | null;
}

/** A case as it will be written, after the shape checks. */
export interface ValidCase {
  sourceUrl: string;
  quote: string;
  occurredAt: Date;
  locationLabel: string;
  locationId: string | null;
  hazardType: string;
  geographicScope: string;
  figures: Prisma.InputJsonValue;
  matchedEventId: string | null;
}

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

function httpUrl(value: string, field: string): string {
  const url = value?.trim();
  if (!url) throw badInput(`${field} is required`);
  if (url.length > MAX_URL_LENGTH) throw badInput(`${field} must be at most ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badInput(`${field} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badInput(`${field} must be an absolute http(s) URL`);
  }
  return url;
}

function requiredText(value: string, field: string, max: number): string {
  const text = value?.trim();
  if (!text) throw badInput(`${field} is required`);
  if (text.length > max) throw badInput(`${field} must be at most ${max} characters`);
  return text;
}

function figure(input: CaseFigureInput, field: string): Record<string, string | number> {
  if (!METRIC_TYPES.has(input.metric)) {
    throw badInput(`${field}.metric must be one of ${[...METRIC_TYPES].join(", ")}`);
  }
  const numbers = { value: input.value, lowerBound: input.lowerBound, upperBound: input.upperBound };
  for (const [name, n] of Object.entries(numbers)) {
    if (n == null) continue;
    if (!Number.isFinite(n) || n < 0) throw badInput(`${field}.${name} must be a non-negative number`);
  }
  if (input.lowerBound != null && input.lowerBound > input.value) {
    throw badInput(`${field}: lowerBound must not exceed value`);
  }
  if (input.upperBound != null && input.upperBound < input.value) {
    throw badInput(`${field}: upperBound must not be below value`);
  }
  const out: Record<string, string | number> = { metric: input.metric, value: input.value };
  if (input.lowerBound != null) out.lowerBound = input.lowerBound;
  if (input.upperBound != null) out.upperBound = input.upperBound;
  if (input.unit?.trim()) out.unit = input.unit.trim();
  if (input.populationGroup?.trim()) out.populationGroup = input.populationGroup.trim();
  return out;
}

/**
 * Shape checks on a completion's cases: required text, an http(s) URL, a
 * date within the request's horizon and not in the future, a known scope,
 * figures on the ontology's metric types with ordered bounds, and no URL
 * twice in one completion.
 */
export function validateCases(
  cases: CaseProposalInput[],
  opts: { horizonYears: number; now: Date },
): ValidCase[] {
  if (cases.length > MAX_CASES_PER_TASK) {
    throw badInput(`At most ${MAX_CASES_PER_TASK} cases per completion`);
  }
  const earliest = new Date(opts.now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - opts.horizonYears);
  const seen = new Set<string>();
  return cases.map((c, i) => {
    const at = `cases[${i}]`;
    const sourceUrl = httpUrl(c.sourceUrl, `${at}.sourceUrl`);
    if (seen.has(sourceUrl)) throw badInput(`${at}.sourceUrl repeats an earlier case: ${sourceUrl}`);
    seen.add(sourceUrl);
    const occurredAt = new Date(c.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw badInput(`${at}.occurredAt must be a valid date-time, e.g. 2026-01-11T00:00:00Z`);
    }
    if (occurredAt.getTime() > opts.now.getTime() + FUTURE_SLACK_MS) {
      throw badInput(`${at}.occurredAt is in the future; a case is something that already happened`);
    }
    if (occurredAt.getTime() < earliest.getTime()) {
      throw badInput(`${at}.occurredAt is older than the request's ${opts.horizonYears}-year horizon`);
    }
    if (!CASE_GEOGRAPHIC_SCOPES.has(c.geographicScope)) {
      throw badInput(`${at}.geographicScope must be "district" or "country"`);
    }
    const figures = c.figures ?? [];
    if (figures.length > MAX_FIGURES_PER_CASE) {
      throw badInput(`${at}: at most ${MAX_FIGURES_PER_CASE} figures per case`);
    }
    return {
      sourceUrl,
      quote: requiredText(c.quote, `${at}.quote`, MAX_QUOTE_LENGTH),
      occurredAt,
      locationLabel: requiredText(c.locationLabel, `${at}.locationLabel`, MAX_LABEL_LENGTH),
      locationId: c.locationId?.trim() || null,
      hazardType: requiredText(c.hazardType, `${at}.hazardType`, 20),
      geographicScope: c.geographicScope,
      figures: figures.map((f, j) => figure(f, `${at}.figures[${j}]`)),
      matchedEventId: c.matchedEventId?.trim() || null,
    };
  });
}
