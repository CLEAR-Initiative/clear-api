/**
 * Briefs: an admin's hand-picked summary of one area over one Brief window,
 * emailed to a Recipient list. Every resolver here is platform-admin only
 * and calls `requireRole(context, ["admin"])` before anything else.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { BriefCadence, BriefItemKind } from "../generated/prisma/enums.js";
import { requireRole } from "../utils/auth-guard.js";
import {
  briefWindow,
  buildBriefItemSnapshot,
  defaultBriefTitle,
  orderBriefItems,
  toBriefEmailView,
} from "../services/briefs.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { brief as briefEmail } from "../services/messaging/templates.js";

const ADMIN = ["admin"];
const MAX_BRIEFS_PAGE = 200;
/** Areas a Brief can cover: country (0), state (1), district (2). */
const MAX_BRIEF_LOCATION_LEVEL = 2;

function notFound(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** Load a Brief that may still change: NOT_FOUND, or BAD_USER_INPUT once sent. */
async function loadDraftBrief(prisma: Context["prisma"], id: string) {
  const row = await prisma.brief.findUnique({ where: { id } });
  if (!row) throw notFound("Brief not found");
  if (row.status !== "draft") throw badInput("Brief already sent");
  return row;
}

interface CreateBriefInput {
  cadence: BriefCadence;
  locationId: string;
  title?: string | null;
}

export const briefResolvers = {
  Query: {
    briefs: async (
      _parent: unknown,
      args: { limit?: number | null; offset?: number | null },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const take = Math.min(Math.max(args.limit ?? 50, 1), MAX_BRIEFS_PAGE);
      const skip = Math.max(args.offset ?? 0, 0);
      return context.prisma.brief.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        skip,
      });
    },

    brief: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireRole(context, ADMIN);
      return context.prisma.brief.findUnique({ where: { id: args.id } });
    },
  },

  Mutation: {
    createBrief: async (
      _parent: unknown,
      args: { input: CreateBriefInput },
      context: Context,
    ) => {
      const user = requireRole(context, ADMIN);
      const { cadence, locationId } = args.input;
      const location = await context.prisma.locations.findUnique({
        where: { id: locationId },
        select: { name: true, level: true },
      });
      if (!location) throw notFound("Location not found");
      if (location.level > MAX_BRIEF_LOCATION_LEVEL) {
        throw badInput("A Brief covers a country, state or district");
      }
      const title = args.input.title?.trim() || defaultBriefTitle(cadence, location.name);
      return context.prisma.brief.create({
        data: {
          cadence,
          title,
          locationId,
          locationName: location.name,
          ...briefWindow(cadence),
          createdById: user.id,
        },
      });
    },

    addBriefItem: async (
      _parent: unknown,
      args: { briefId: string; kind: BriefItemKind; entityId: string },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const { briefId, kind, entityId } = args;
      await loadDraftBrief(context.prisma, briefId);

      const existing = await context.prisma.briefItem.findUnique({
        where: { briefId_kind_entityId: { briefId, kind, entityId } },
      });
      if (existing) return existing;

      const snapshot = await buildBriefItemSnapshot(context.prisma, kind, entityId);
      if (!snapshot) throw notFound(`No ${kind} with id ${entityId}`);

      const last = await context.prisma.briefItem.aggregate({
        where: { briefId, kind },
        _max: { position: true },
      });
      const position = (last._max.position ?? -1) + 1;
      // upsert, not create: a concurrent pick of the same item returns the
      // row the other request wrote instead of failing on the unique key.
      return context.prisma.briefItem.upsert({
        where: { briefId_kind_entityId: { briefId, kind, entityId } },
        create: { briefId, kind, entityId, position, snapshot: { ...snapshot } },
        update: {},
      });
    },

    sendBriefTest: async (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireRole(context, ADMIN);
      const row = await context.prisma.brief.findUnique({
        where: { id: args.id },
        include: { items: true },
      });
      if (!row) throw notFound("Brief not found");
      const content = briefEmail(toBriefEmailView(row, row.items), {
        unsubscribeUrl: null,
        isTest: true,
      });
      const provider = await getEmailProvider();
      return provider.send({ to: user.email, ...content });
    },
  },

  Brief: {
    items: async (parent: { id: string; items?: unknown }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      const items = await context.prisma.briefItem.findMany({ where: { briefId: parent.id } });
      return orderBriefItems(items);
    },
  },

  BriefItem: {
    snapshot: (parent: { snapshot: unknown }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      return parent.snapshot;
    },
  },
};
