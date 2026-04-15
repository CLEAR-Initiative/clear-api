import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { sendCeleryTask } from "../services/celery.js";

interface CreateSituationFromEventsInput {
  title?: string;
  summary?: string;
  severity: number;
  locationId?: string;
  needs: Record<string, unknown>;
  eventIds: string[];
}

interface UpdateSituationPopulationInput {
  populationAffected?: string | null;
  populationInArea?: string | null;
  title?: string | null;
  summary?: string | null;
}

/**
 * Compute the sum of `populationAffected` across a list of events (BigInt-safe).
 * Returns null if every event has a null value.
 */
async function sumEventPopulationAffected(
  prisma: Context["prisma"],
  eventIds: string[],
): Promise<bigint | null> {
  if (eventIds.length === 0) return null;
  const events = await prisma.events.findMany({
    where: { id: { in: eventIds } },
    select: { populationAffected: true },
  });
  let total = 0n;
  let any = false;
  for (const e of events) {
    if (e.populationAffected !== null) {
      total += e.populationAffected;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Collect the level-2 (district) ancestor IDs for the locations touched by
 * a list of events. Falls back to the event's own location when it's already
 * at level 2, or to its level-2 ancestor otherwise.
 */
async function collectDistrictIds(
  prisma: Context["prisma"],
  eventIds: string[],
): Promise<string[]> {
  if (eventIds.length === 0) return [];

  const events = await prisma.events.findMany({
    where: { id: { in: eventIds } },
    select: { originId: true, destinationId: true, locationId: true },
  });

  const eventLocationIds = new Set<string>();
  for (const e of events) {
    if (e.originId) eventLocationIds.add(e.originId);
    if (e.destinationId) eventLocationIds.add(e.destinationId);
    if (e.locationId) eventLocationIds.add(e.locationId);
  }
  if (eventLocationIds.size === 0) return [];

  const locations = await prisma.locations.findMany({
    where: { id: { in: [...eventLocationIds] } },
    select: { id: true, level: true, ancestorIds: true },
  });

  const candidateIds = new Set<string>();
  for (const loc of locations) {
    if (loc.level === 2) {
      candidateIds.add(loc.id);
    } else if (loc.level > 2) {
      for (const aid of loc.ancestorIds) candidateIds.add(aid);
    } else {
      // level < 2 (country/state) — not specific enough, skip
    }
  }
  if (candidateIds.size === 0) return [];

  // Filter down to actual level-2 districts
  const districts = await prisma.locations.findMany({
    where: { id: { in: [...candidateIds] }, level: 2 },
    select: { id: true },
  });
  return districts.map((d) => d.id);
}

/**
 * Dispatch the pipeline task that enriches a situation: computes
 * `populationInArea` from the given districts AND generates a narrative
 * (title + summary) via Claude across the linked events.
 */
async function dispatchSituationEnrichmentTask(
  situationId: string,
  eventIds: string[],
  districtIds: string[],
  generateNarrative: boolean,
): Promise<void> {
  try {
    await sendCeleryTask("src.tasks.situation.enrich_situation", {
      situation_id: situationId,
      event_ids: eventIds,
      district_ids: districtIds,
      generate_narrative: generateNarrative,
    });
  } catch (err) {
    console.error(
      `[situation] Failed to dispatch enrichment task for ${situationId}:`,
      err,
    );
  }
}

export const situationResolvers = {
  Query: {
    situations: async (_parent: unknown, _args: unknown, context: Context) => {
      requireAuth(context);
      return context.prisma.situations.findMany();
    },

    situation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireAuth(context);
      const situation = await context.prisma.situations.findUnique({
        where: { id: args.id },
      });
      if (!situation) {
        throw new GraphQLError("Situation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return situation;
    },
  },

  Mutation: {
    /**
     * Create a new situation from a list of event IDs.
     * Validates that all event IDs exist, then creates the situation and
     * the event-situation join records in a single transaction.
     */
    createSituationFromEvents: async (
      _parent: unknown,
      args: { input: CreateSituationFromEventsInput },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      if (input.eventIds.length === 0) {
        throw new GraphQLError("At least one event ID is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Validate all events exist
      const existingEvents = await context.prisma.events.findMany({
        where: { id: { in: input.eventIds } },
        select: { id: true },
      });
      if (existingEvents.length !== input.eventIds.length) {
        const found = new Set(existingEvents.map((e) => e.id));
        const missing = input.eventIds.filter((id) => !found.has(id));
        throw new GraphQLError(
          `Event(s) not found: ${missing.join(", ")}`,
          { extensions: { code: "NOT_FOUND" } },
        );
      }

      // Sum populationAffected from the events (sync, cheap)
      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        input.eventIds,
      );

      // Create situation + join rows in a transaction
      const collectedAt = new Date();
      const situation = await context.prisma.$transaction(async (tx) => {
        const created = await tx.situations.create({
          data: {
            title: input.title ?? undefined,
            summary: input.summary ?? undefined,
            severity: input.severity,
            locationId: input.locationId ?? undefined,
            needs: input.needs as InputJsonValue,
            populationAffected: populationAffected ?? undefined,
          },
        });

        await tx.eventSituations.createMany({
          data: input.eventIds.map((eventId) => ({
            situationId: created.id,
            eventId,
            collectedAt,
          })),
        });

        return created;
      });

      // Async: dispatch Celery task for populationInArea + narrative (if not provided)
      const districtIds = await collectDistrictIds(context.prisma, input.eventIds);
      const generateNarrative = !input.title || !input.summary;
      void dispatchSituationEnrichmentTask(
        situation.id,
        input.eventIds,
        districtIds,
        generateNarrative,
      );

      return situation;
    },

    /**
     * Add an event to an existing situation.
     * Idempotent — returns the existing link if one already exists.
     */
    addEventToSituation: async (
      _parent: unknown,
      args: { situationId: string; eventId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { situationId, eventId } = args;

      // Validate both exist
      const [situation, event] = await Promise.all([
        context.prisma.situations.findUnique({ where: { id: situationId } }),
        context.prisma.events.findUnique({ where: { id: eventId } }),
      ]);

      if (!situation) {
        throw new GraphQLError("Situation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Check for existing link (idempotency)
      const existing = await context.prisma.eventSituations.findFirst({
        where: { situationId, eventId },
      });
      if (existing) return existing;

      const link = await context.prisma.eventSituations.create({
        data: {
          situationId,
          eventId,
          collectedAt: new Date(),
        },
      });

      // Recompute populations for the whole situation
      const allLinks = await context.prisma.eventSituations.findMany({
        where: { situationId },
        select: { eventId: true },
      });
      const allEventIds = allLinks.map((l) => l.eventId);

      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        allEventIds,
      );
      await context.prisma.situations.update({
        where: { id: situationId },
        data: { populationAffected },
      });

      const districtIds = await collectDistrictIds(context.prisma, allEventIds);
      // Regenerate narrative on add — keeps title/summary coherent as events grow
      void dispatchSituationEnrichmentTask(
        situationId,
        allEventIds,
        districtIds,
        true,
      );

      return link;
    },

    updateSituationPopulation: async (
      _parent: unknown,
      args: { id: string; input: UpdateSituationPopulationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.situations.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Situation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const data: {
        populationAffected?: bigint | null;
        populationInArea?: bigint | null;
        title?: string | null;
        summary?: string | null;
      } = {};
      if (input.populationAffected !== undefined) {
        data.populationAffected = input.populationAffected === null
          ? null
          : BigInt(input.populationAffected);
      }
      if (input.populationInArea !== undefined) {
        data.populationInArea = input.populationInArea === null
          ? null
          : BigInt(input.populationInArea);
      }
      if (input.title !== undefined) data.title = input.title;
      if (input.summary !== undefined) data.summary = input.summary;

      return context.prisma.situations.update({ where: { id }, data });
    },
  },

  Situation: {
    generalLocation: (
      parent: { locationId: string | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (!parent.locationId) return null;
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
    populationAffected: (parent: { populationAffected: bigint | null }) => {
      return parent.populationAffected?.toString() ?? null;
    },
    populationInArea: (parent: { populationInArea: bigint | null }) => {
      return parent.populationInArea?.toString() ?? null;
    },
    events: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.eventSituations
        .findMany({
          where: { situationId: parent.id },
          include: { event: true },
        })
        .then((links) => links.map((l) => l.event));
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { situationId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { situationId: parent.id } });
    },
  },

  EventSituation: {
    situation: (
      parent: { situationId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.situations.findUnique({ where: { id: parent.situationId } });
    },
    event: (
      parent: { eventId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
  },
};
