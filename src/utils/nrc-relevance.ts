/**
 * NRC-relevance helpers, keyed off `disaster_types.nrc_relevant`.
 *
 * Relevance is defined per glide code (level_3). Consumers:
 *   - Alert raising gates on the event's glide codes (`events.types`).
 *   - Knowledgebase ranking demotes two tiers that tag event types differently:
 *       - report chunks (`knowledge_base.event_types`) carry level_2 labels →
 *         compare against {@link nrcIrrelevantLevel2}.
 *       - incident cards (`events_index.event_types`) carry glide codes →
 *         compare against {@link nrcIrrelevantGlideCodes}.
 */
import type { PrismaClient } from "../generated/prisma/client.js";

type PrismaLike = Pick<PrismaClient, "disasterTypes">;

/**
 * True if ANY of the given glide codes maps to an NRC-relevant disaster type.
 * An event is NRC-relevant when at least one of its `types` is relevant; an
 * event with no types, or only out-of-interest types, is not. Empty → false.
 *
 * Codes are matched case-insensitively: `events.types` may store uppercase
 * glide codes (e.g. "FL") while `disaster_types.glide_number` is lowercase, so
 * we lowercase the input before the `in` filter (Prisma `in` has no case mode).
 */
export async function anyTypeNrcRelevant(
  prisma: PrismaLike,
  glideCodes: readonly string[] | null | undefined,
): Promise<boolean> {
  if (!glideCodes || glideCodes.length === 0) return false;
  const normalized = glideCodes.map((c) => (c ?? "").trim().toLowerCase());
  const relevant = await prisma.disasterTypes.count({
    where: { glideNumber: { in: normalized }, nrcRelevant: true },
  });
  return relevant > 0;
}

/**
 * Lowercased glide codes (level_3) that are NRC-irrelevant
 * (`disaster_types.nrc_relevant = false`). Incident knowledgebase cards
 * (`events_index.event_types`) carry glide codes copied verbatim from
 * `events.types` (see `synthesiseEventCard`), so incident demotion compares
 * against THIS set, not the level_2 one. An incident counts as all-out-of-interest
 * iff every one of its codes is in here.
 */
export async function nrcIrrelevantGlideCodes(prisma: PrismaLike): Promise<Set<string>> {
  const rows = await prisma.disasterTypes.findMany({
    where: { nrcRelevant: false },
    select: { glideNumber: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    const code = (r.glideNumber ?? "").trim().toLowerCase();
    if (code) out.add(code);
  }
  return out;
}

/**
 * Lowercased level_2 slugs that are ENTIRELY NRC-irrelevant — i.e. no glide code
 * under that level_2 group is relevant. Knowledgebase chunks tag `event_types`
 * as level_2 slugs (classify.level2_values == disaster_types.level_2), so a chunk
 * counts as all-out-of-interest iff every one of its tags is in this set.
 *
 * Computed from the data, so it stays correct if the taxonomy changes. With the
 * current taxonomy this is only the fully out-of-interest groups (e.g. "fire" and
 * natural-hazard "other"); a conflict group such as "protests" still contains a
 * relevant code (protest with intervention) and is therefore NOT in the set.
 */
export async function nrcIrrelevantLevel2(prisma: PrismaLike): Promise<Set<string>> {
  const rows = await prisma.disasterTypes.findMany({
    select: { level2: true, nrcRelevant: true },
  });
  const seen = new Set<string>();
  const hasRelevant = new Set<string>();
  for (const r of rows) {
    const l2 = (r.level2 ?? "").trim().toLowerCase();
    if (!l2) continue;
    seen.add(l2);
    if (r.nrcRelevant) hasRelevant.add(l2);
  }
  const irrelevant = new Set<string>();
  for (const l2 of seen) if (!hasRelevant.has(l2)) irrelevant.add(l2);
  return irrelevant;
}

/**
 * Whether a knowledgebase chunk's `event_types` are ALL NRC-irrelevant (so it
 * should be demoted). A chunk with no types is left as-is (not demoted) — there
 * is no NRC signal to act on. `irrelevantLevel2` comes from {@link nrcIrrelevantLevel2}.
 */
export function chunkIsAllNrcIrrelevant(
  eventTypes: readonly string[] | null | undefined,
  irrelevantLevel2: Set<string>,
): boolean {
  if (!eventTypes || eventTypes.length === 0) return false;
  return eventTypes.every((t) => irrelevantLevel2.has((t ?? "").trim().toLowerCase()));
}
