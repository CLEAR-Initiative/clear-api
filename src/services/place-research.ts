/**
 * Place research (ADR-0010 and ADR-0019 amendments, decision D-0296).
 *
 * A Worker researches one unresolved place name and proposes a point with
 * sources. The Task kind is `place_name.locate.web`; its subject is a row of
 * the Places queue. The typed result is a place proposal: one row in
 * `place_name_proposals` per completed Task. The Worker never resolves a
 * name: a decider uses a proposal through `resolveUnresolvedPlaceName`.
 *
 * This module holds what the request, the completion and the read share:
 * the Task payload, the create with its dedupe, the shape checks on a
 * proposal and the country check on its point.
 */

import { randomUUID } from "node:crypto";
import { GraphQLError } from "graphql";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../utils/env.js";
import { resolveContainingAdminArea } from "../utils/geo-resolve.js";
import { PLACE_NAME_SUBJECT, PLACE_RESEARCH_KIND } from "../utils/task-kinds.js";
import { countryLocationIdForCode } from "./place-names.js";

type TaskRow = Prisma.taskGetPayload<Record<string, never>>;

export const PLACE_PROPOSAL_OUTCOMES = ["found", "not_found", "not_a_place"] as const;
export type PlaceProposalOutcome = (typeof PLACE_PROPOSAL_OUTCOMES)[number];
export const PLACE_PROPOSAL_CONFIDENCES = ["high", "medium", "low"] as const;
export type PlaceProposalConfidence = (typeof PLACE_PROPOSAL_CONFIDENCES)[number];

/** Signals whose ids go into the payload: the newest ones of the row. */
export const PLACE_RESEARCH_SIGNALS = 10;
/** Sources per proposal. A Worker cites a few; a runaway one must not bloat the row. */
export const MAX_PLACE_SOURCES = 20;
const MAX_URL_LENGTH = 2048;
const MAX_QUOTE_LENGTH = 4000;
const MAX_REASON_LENGTH = 2000;
const MAX_NAME_LENGTH = 500;
const MAX_METHOD_VERSION_LENGTH = 200;

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

/** The queue row's fields that place research reads. */
export interface PlaceResearchRow {
  id: string;
  nameAsWritten: string;
  nameAr: string | null;
  countryCode: string;
  stateLocationId: string | null;
  countryLocationId: string | null;
}

/**
 * What the Worker gets with the Task. The `worker` role cannot read the
 * Places queue, so the payload carries all it needs to start: the name, the
 * Arabic name, the country, the state, and the ids of the newest Signals
 * that name the place (it reads each with `signal(id)`).
 */
export interface PlaceResearchPayload {
  name: string;
  nameAr: string | null;
  countryCode: string;
  stateLocationId: string | null;
  stateName: string | null;
  signalIds: string[];
}

export async function buildPlaceResearchPayload(
  prisma: PrismaClient,
  row: PlaceResearchRow,
): Promise<PlaceResearchPayload> {
  const [state, links] = await Promise.all([
    row.stateLocationId
      ? prisma.locations.findUnique({ where: { id: row.stateLocationId }, select: { name: true } })
      : Promise.resolve(null),
    prisma.unresolvedPlaceNameSignals.findMany({
      where: { unresolvedPlaceNameId: row.id },
      orderBy: [{ seenAt: "desc" }, { signalId: "asc" }],
      take: PLACE_RESEARCH_SIGNALS,
      select: { signalId: true },
    }),
  ]);
  return {
    name: row.nameAsWritten,
    nameAr: row.nameAr,
    countryCode: row.countryCode,
    stateLocationId: row.stateLocationId,
    stateName: state?.name ?? null,
    signalIds: links.map((l) => l.signalId),
  };
}

const openWhere = (rowId: string): Prisma.taskWhereInput => ({
  kind: PLACE_RESEARCH_KIND,
  subjectType: PLACE_NAME_SUBJECT,
  subjectId: rowId,
  status: { in: ["PENDING", "LEASED"] },
});

/** The row's open (PENDING or LEASED) place research Task, or null. The
 *  index `tasks_open_subject_uk` allows at most one. */
export function findOpenPlaceResearchTask(prisma: PrismaClient, rowId: string): Promise<TaskRow | null> {
  return prisma.task.findFirst({ where: openWhere(rowId) });
}

/**
 * Create the place research Task of a row. The caller has checked the row's
 * status, the dedupe and its cap. A concurrent identical request can still
 * win the create: the partial unique index rejects this one, and the
 * winner's Task comes back with `created: false`.
 */
export async function createPlaceResearchTask(
  prisma: PrismaClient,
  row: PlaceResearchRow,
  by: { origin: "user" | "api" | "rule"; requesterId: string | null },
): Promise<{ task: TaskRow; created: boolean }> {
  const payload = await buildPlaceResearchPayload(prisma, row);
  try {
    const task = await prisma.task.create({
      data: {
        kind: PLACE_RESEARCH_KIND,
        subjectType: PLACE_NAME_SUBJECT,
        subjectId: row.id,
        payload: payload as unknown as Prisma.InputJsonObject,
        requestId: randomUUID(),
        origin: by.origin,
        requesterId: by.requesterId,
        // A queue row belongs to a state, not to a team.
        teamId: null,
        maxAttempts: env.TASK_MAX_ATTEMPTS,
      },
    });
    return { task, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const winner = await findOpenPlaceResearchTask(prisma, row.id);
      if (winner) return { task: winner, created: false };
      // The winner completed before it could be read back.
      throw new GraphQLError("Tasks changed while requesting; retry", { extensions: { code: "CONFLICT" } });
    }
    throw e;
  }
}

// ─── The proposal a Worker sends ─────────────────────────────────────────────

export interface PlaceProposalSourceInput {
  url: string;
  quote: string;
}

export interface PlaceProposalInput {
  outcome: PlaceProposalOutcome;
  latitude?: number | null;
  longitude?: number | null;
  nameFound?: string | null;
  confidence?: PlaceProposalConfidence | null;
  reason: string;
  sources?: PlaceProposalSourceInput[] | null;
}

/** A proposal as it will be written, after the shape checks. */
export interface ValidPlaceProposal {
  outcome: PlaceProposalOutcome;
  latitude: number | null;
  longitude: number | null;
  nameFound: string | null;
  confidence: PlaceProposalConfidence | null;
  reason: string;
  sources: PlaceProposalSourceInput[];
}

function requiredText(value: string | null | undefined, field: string, max: number): string {
  const text = value?.trim();
  if (!text) throw badInput(`${field} is required`);
  if (text.length > max) throw badInput(`${field} must be at most ${max} characters`);
  return text;
}

function httpUrl(value: string, field: string): string {
  const url = requiredText(value, field, MAX_URL_LENGTH);
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

export function validateMethodVersion(value: string | null | undefined): string {
  return requiredText(value, "methodVersion", MAX_METHOD_VERSION_LENGTH);
}

/**
 * Shape checks on a place proposal, with no database. `found` needs a point,
 * the name found, a confidence, a reason and one or more sources.
 * `not_found` and `not_a_place` need a reason and take no point, no name and
 * no confidence; their sources are optional (what the Worker read).
 */
export function validatePlaceProposal(input: PlaceProposalInput): ValidPlaceProposal {
  if (!PLACE_PROPOSAL_OUTCOMES.includes(input.outcome)) {
    throw badInput(`place.outcome must be one of ${PLACE_PROPOSAL_OUTCOMES.join(", ")}`);
  }
  const reason = requiredText(input.reason, "place.reason", MAX_REASON_LENGTH);
  const given = input.sources ?? [];
  if (given.length > MAX_PLACE_SOURCES) throw badInput(`At most ${MAX_PLACE_SOURCES} sources per place proposal`);
  const sources = given.map((s, i) => ({
    url: httpUrl(s.url, `place.sources[${i}].url`),
    quote: requiredText(s.quote, `place.sources[${i}].quote`, MAX_QUOTE_LENGTH),
  }));

  if (input.outcome !== "found") {
    for (const field of ["latitude", "longitude", "nameFound", "confidence"] as const) {
      if (input[field] != null) throw badInput(`place.${field} is not accepted with outcome "${input.outcome}"`);
    }
    return { outcome: input.outcome, latitude: null, longitude: null, nameFound: null, confidence: null, reason, sources };
  }

  const { latitude, longitude } = input;
  if (latitude == null || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw badInput("place.latitude is required with outcome \"found\": a finite number in [-90, 90]");
  }
  if (longitude == null || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw badInput("place.longitude is required with outcome \"found\": a finite number in [-180, 180]");
  }
  const nameFound = requiredText(input.nameFound, "place.nameFound", MAX_NAME_LENGTH);
  if (!input.confidence || !PLACE_PROPOSAL_CONFIDENCES.includes(input.confidence)) {
    throw badInput(`place.confidence is required with outcome "found": one of ${PLACE_PROPOSAL_CONFIDENCES.join(", ")}`);
  }
  if (sources.length === 0) throw badInput("place.sources needs one or more sources with outcome \"found\"");
  return { outcome: "found", latitude, longitude, nameFound, confidence: input.confidence, reason, sources };
}

/**
 * Refuse a point outside the row's country. The test is the one
 * `resolveUnresolvedPlaceName` runs for a `POINT` answer: the admin area
 * that contains the point must be the country or lie inside it. A proposal
 * that passes can therefore be used to resolve the row. A row whose country
 * has no location cannot be checked, so its point is refused too.
 */
export async function assertPointInRowCountry(
  prisma: PrismaClient,
  row: Pick<PlaceResearchRow, "countryCode" | "countryLocationId">,
  latitude: number,
  longitude: number,
): Promise<void> {
  const countryId = row.countryLocationId ?? (await countryLocationIdForCode(prisma, row.countryCode));
  if (!countryId) {
    throw badInput(`The place name's country (${row.countryCode}) has no location in CLEAR; a point cannot be checked`);
  }
  const placement = await resolveContainingAdminArea(prisma, latitude, longitude);
  const area = placement
    ? await prisma.locations.findUnique({ where: { id: placement.id }, select: { id: true, ancestorIds: true } })
    : null;
  if (!area || !(area.id === countryId || area.ancestorIds.includes(countryId))) {
    throw new GraphQLError(
      `The point (${latitude}, ${longitude}) is outside the country of this place name (${row.countryCode}). ` +
        "Nothing was stored and the Task is still leased: correct the point, or fail the Task.",
      { extensions: { code: "BAD_USER_INPUT", subCode: "POINT_OUTSIDE_COUNTRY" } },
    );
  }
}

/** Two coordinates are the same point when they differ by less than about a metre. */
export const SAME_POINT_DEGREES = 1e-5;
