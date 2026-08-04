/**
 * Resolvers for the ground intel staging tier.
 *
 * The whole tier is PRIVATE: every query and mutation requires the global
 * admin or analyst role (`requireGroundReviewer` additionally consults the
 * source's own reviewerRoles for review actions). Viewers — who can read
 * signals/events — deliberately cannot see staged ground content: sender
 * names, unredacted-adjacent context, and unvetted claims live here.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import { getPresignedUrls } from "../services/s3.js";

const GROUND_SOURCE_KINDS = new Set(["staff_group", "partner_group", "hotline"]);

export const groundResolvers = {
  Query: {
    groundSources: async (_parent: unknown, _args: unknown, context: Context) => {
      requireRole(context, ["admin", "analyst"]);
      return context.prisma.groundSources.findMany({ orderBy: { createdAt: "desc" } });
    },

    groundThreads: async (
      _parent: unknown,
      args: {
        groundSourceId?: string | null;
        reviewState?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      return context.prisma.groundThreads.findMany({
        where: {
          ...(args.groundSourceId ? { groundSourceId: args.groundSourceId } : {}),
          ...(args.reviewState ? { reviewState: args.reviewState } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(args.limit ?? 100, 500),
        skip: args.offset ?? 0,
      });
    },

    groundThread: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireRole(context, ["admin", "analyst"]);
      return context.prisma.groundThreads.findUnique({ where: { id: args.id } });
    },

    groundMessages: async (
      _parent: unknown,
      args: {
        groundSourceId?: string | null;
        threadId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      return context.prisma.groundMessages.findMany({
        where: {
          ...(args.groundSourceId ? { groundSourceId: args.groundSourceId } : {}),
          ...(args.threadId ? { threadId: args.threadId } : {}),
        },
        orderBy: { sentAt: "asc" },
        take: Math.min(args.limit ?? 200, 1000),
        skip: args.offset ?? 0,
      });
    },
  },

  Mutation: {
    createGroundSource: async (
      _parent: unknown,
      args: {
        input: {
          name: string;
          kind: string;
          transportId: string;
          consentScope?: string | null;
          consentRecordedAt?: string | null;
          consentRecordedBy?: string | null;
          privacyDefault?: string | null;
          reviewerRoles?: string[] | null;
          retentionRule?: string | null;
        };
      },
      context: Context,
    ) => {
      requireRole(context, ["admin", "analyst"]);
      const { input } = args;

      if (!GROUND_SOURCE_KINDS.has(input.kind)) {
        throw new GraphQLError(
          `kind must be one of: ${[...GROUND_SOURCE_KINDS].join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      return context.prisma.groundSources.create({
        data: {
          name: input.name,
          kind: input.kind,
          transportId: input.transportId,
          consentScope: input.consentScope ?? null,
          consentRecordedAt: input.consentRecordedAt
            ? new Date(input.consentRecordedAt)
            : null,
          consentRecordedBy: input.consentRecordedBy ?? null,
          privacyDefault: input.privacyDefault ?? "private",
          ...(input.reviewerRoles ? { reviewerRoles: input.reviewerRoles } : {}),
          retentionRule: input.retentionRule ?? null,
        },
      });
    },
  },

  GroundMessage: {
    /** Presigned GET URLs for the stored attachments, generated at read
     * time (same pattern as signal media). Empty when the message has no
     * stored media. */
    mediaUrls: async (parent: { mediaKeys: string[] }) => {
      if (parent.mediaKeys.length === 0) return [];
      return getPresignedUrls(parent.mediaKeys);
    },
  },

  GroundThread: {
    source: async (
      parent: { groundSourceId: string },
      _args: unknown,
      context: Context,
    ) => {
      return context.prisma.groundSources.findUnique({
        where: { id: parent.groundSourceId },
      });
    },
    messages: async (parent: { id: string }, _args: unknown, context: Context) => {
      return context.prisma.groundMessages.findMany({
        where: { threadId: parent.id },
        orderBy: { sentAt: "asc" },
      });
    },
  },
};
