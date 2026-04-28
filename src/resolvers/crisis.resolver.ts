import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";
import { sendCeleryTask } from "../services/celery.js";

interface CreateCrisisFromEventsInput {
  title?: string;
  summary?: string;
  severity: number;
  locationId?: string;
  needs: Record<string, unknown>;
  eventIds: string[];
}

interface UpdateCrisisPopulationInput {
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
 * Collect the most specific usable location IDs for the events.
 *
 * Strategy: prefer level-2 (district), fall back to level-1 (state), then
 * level-0 (country). For events with point locations (level 4), we pick the
 * level-2 ancestor. The pipeline task then further falls back to a parent
 * when the chosen location lacks an areal geometry/cached population.
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

  // For each event location, pick the most specific ancestor ≤ level 2
  const candidateIds = new Set<string>();
  for (const loc of locations) {
    if (loc.level <= 2) {
      candidateIds.add(loc.id);
    } else {
      // Point or deeper — use ancestors (walk up to find the nearest level-2)
      for (const aid of loc.ancestorIds) candidateIds.add(aid);
    }
  }
  if (candidateIds.size === 0) return [];

  // Prefer level-2 where available; otherwise fall back to level-1, then 0
  const candidates = await prisma.locations.findMany({
    where: { id: { in: [...candidateIds] }, level: { lte: 2 } },
    select: { id: true, level: true },
  });
  if (candidates.length === 0) return [];

  const byLevel2 = candidates.filter((c) => c.level === 2);
  if (byLevel2.length > 0) return byLevel2.map((c) => c.id);

  const byLevel1 = candidates.filter((c) => c.level === 1);
  if (byLevel1.length > 0) return byLevel1.map((c) => c.id);

  return candidates.map((c) => c.id);
}

/**
 * Dispatch the pipeline task that enriches a crisis: computes
 * `populationInArea` from the given districts AND generates a narrative
 * (title + summary) via Claude across the linked events.
 */
async function dispatchCrisisEnrichmentTask(
  crisisId: string,
  eventIds: string[],
  districtIds: string[],
  generateNarrative: boolean,
): Promise<void> {
  try {
    await sendCeleryTask("src.tasks.crisis.enrich_crisis", {
      crisis_id: crisisId,
      event_ids: eventIds,
      district_ids: districtIds,
      generate_narrative: generateNarrative,
    });
  } catch (err) {
    console.error(
      `[crisis] Failed to dispatch enrichment task for ${crisisId}:`,
      err,
    );
  }
}

export const crisisResolvers = {
  Query: {
    crises: async (_parent: unknown, _args: unknown, context: Context) => {
      requireAuth(context);
      return context.prisma.crises.findMany();
    },

    crisis: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireAuth(context);
      const crisis = await context.prisma.crises.findUnique({
        where: { id: args.id },
      });
      if (!crisis) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return crisis;
    },
  },

  Mutation: {
    /**
     * Create a new crisis from a list of event IDs.
     * Validates that all event IDs exist, then creates the crisis and
     * the event-crisis join records in a single transaction.
     */
    createCrisisFromEvents: async (
      _parent: unknown,
      args: { input: CreateCrisisFromEventsInput },
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

      // Create crisis + join rows in a transaction
      const collectedAt = new Date();
      const crisis = await context.prisma.$transaction(async (tx) => {
        const created = await tx.crises.create({
          data: {
            title: input.title ?? undefined,
            summary: input.summary ?? undefined,
            severity: input.severity,
            locationId: input.locationId ?? undefined,
            needs: input.needs as InputJsonValue,
            populationAffected: populationAffected ?? undefined,
          },
        });

        await tx.eventCrises.createMany({
          data: input.eventIds.map((eventId) => ({
            crisisId: created.id,
            eventId,
            collectedAt,
          })),
        });

        return created;
      });

      // Async: dispatch Celery task for populationInArea + narrative (if not provided)
      const districtIds = await collectDistrictIds(context.prisma, input.eventIds);
      const generateNarrative = !input.title || !input.summary;
      void dispatchCrisisEnrichmentTask(
        crisis.id,
        input.eventIds,
        districtIds,
        generateNarrative,
      );

      return crisis;
    },

    /**
     * Add an event to an existing crisis.
     * Idempotent — returns the existing link if one already exists.
     */
    addEventToCrisis: async (
      _parent: unknown,
      args: { crisisId: string; eventId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { crisisId, eventId } = args;

      // Validate both exist
      const [crisis, event] = await Promise.all([
        context.prisma.crises.findUnique({ where: { id: crisisId } }),
        context.prisma.events.findUnique({ where: { id: eventId } }),
      ]);

      if (!crisis) {
        throw new GraphQLError("Crisis not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (!event) {
        throw new GraphQLError("Event not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Check for existing link (idempotency)
      const existing = await context.prisma.eventCrises.findFirst({
        where: { crisisId, eventId },
      });
      if (existing) return existing;

      const link = await context.prisma.eventCrises.create({
        data: {
          crisisId,
          eventId,
          collectedAt: new Date(),
        },
      });

      // Recompute populations for the whole crisis
      const allLinks = await context.prisma.eventCrises.findMany({
        where: { crisisId },
        select: { eventId: true },
      });
      const allEventIds = allLinks.map((l) => l.eventId);

      const populationAffected = await sumEventPopulationAffected(
        context.prisma,
        allEventIds,
      );
      await context.prisma.crises.update({
        where: { id: crisisId },
        data: { populationAffected },
      });

      const districtIds = await collectDistrictIds(context.prisma, allEventIds);
      // Regenerate narrative on add — keeps title/summary coherent as events grow
      void dispatchCrisisEnrichmentTask(
        crisisId,
        allEventIds,
        districtIds,
        true,
      );

      return link;
    },

    updateCrisisPopulation: async (
      _parent: unknown,
      args: { id: string; input: UpdateCrisisPopulationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.crises.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("Crisis not found", {
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

      return context.prisma.crises.update({ where: { id }, data });
    },
  },

  Crisis: {
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
      return prisma.eventCrises
        .findMany({
          where: { crisisId: parent.id },
          include: { event: true },
        })
        .then((links) => links.map((l) => l.event));
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { crisisId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { crisisId: parent.id } });
    },
  },

  EventCrisis: {
    crisis: (
      parent: { crisisId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.crises.findUnique({ where: { id: parent.crisisId } });
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
