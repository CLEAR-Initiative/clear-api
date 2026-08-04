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
import { canReviewSource, reviewTransition } from "../services/ground-review.js";
import {
  buildPromotedSignalInput,
  ensureWhatsAppDataSource,
} from "../services/ground-promotion.js";
import { signalResolvers } from "./signal.resolver.js";

const GROUND_SOURCE_KINDS = new Set(["staff_group", "partner_group", "hotline"]);

/**
 * Promote an approved-public thread into the signals graph. Reuses the
 * existing createSignal resolver so promoted signals get the exact same
 * treatment as pipeline ones (dedupe on (sourceId, externalId), location
 * resolution, P2002 fallback). Returns the signal id.
 *
 * Identity scrubbing happens structurally: buildPromotedSignalInput's
 * message type has no sender fields at all (see ground-promotion.ts).
 */
async function promoteThread(context: Context, threadId: string): Promise<string> {
  const thread = await context.prisma.groundThreads.findUnique({
    where: { id: threadId },
    include: { messages: { orderBy: { sentAt: "asc" } } },
  });
  if (!thread) {
    throw new GraphQLError("Ground thread not found", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  if (thread.messages.length === 0) {
    throw new GraphQLError("Cannot promote a thread with no messages", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }

  const dataSource = await ensureWhatsAppDataSource(context.prisma);

  // Presigned URLs for all attachments across the thread, generated at
  // promotion time (media URLs are what CreateSignalInput carries).
  const mediaKeys = thread.messages.flatMap((m) => m.mediaKeys);
  const mediaUrls = mediaKeys.length > 0 ? await getPresignedUrls(mediaKeys) : [];

  const input = buildPromotedSignalInput({
    dataSourceId: dataSource.id,
    thread: {
      id: thread.id,
      title: thread.title,
      lifecycleState: thread.lifecycleState,
    },
    messages: thread.messages.map((m) => ({
      externalId: m.externalId,
      sentAt: m.sentAt,
      text: m.text,
      mediaKeys: m.mediaKeys,
      omittedMediaCount: m.omittedMediaCount,
      classification: m.classification,
      uncertainty: m.uncertainty,
      isEdited: m.isEdited,
    })),
    mediaUrls,
  });

  const signal = await signalResolvers.Mutation.createSignal(null, { input }, context);
  return signal.id;
}

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
    reviewGroundThread: async (
      _parent: unknown,
      args: { id: string; decision: string; note?: string | null },
      context: Context,
    ) => {
      // Coarse gate first (viewers/pending never reach the queue), then
      // the per-source reviewerRoles policy record decides.
      const user = requireRole(context, ["admin", "analyst"]);

      const thread = await context.prisma.groundThreads.findUnique({
        where: { id: args.id },
        include: { source: true },
      });
      if (!thread) {
        throw new GraphQLError("Ground thread not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (!canReviewSource(user, thread.source.reviewerRoles)) {
        throw new GraphQLError(
          `Reviewing this source requires one of: ${thread.source.reviewerRoles.join(", ")}`,
          { extensions: { code: "FORBIDDEN" } },
        );
      }

      const transition = reviewTransition(thread.reviewState, args.decision);
      if (!transition.ok) {
        throw new GraphQLError(transition.reason, {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // approve_public promotes BEFORE the state flips: if promotion
      // fails, the thread stays reviewable and the decision can be
      // retried. createSignal's (sourceId, externalId) dedupe makes the
      // retry idempotent. The guard on promotedSignalId is belt and
      // braces — the state machine already makes approved_public
      // terminal, so a thread cannot be promoted twice.
      let promotedSignalId: string | null = null;
      if (transition.next === "approved_public" && !thread.promotedSignalId) {
        promotedSignalId = await promoteThread(context, thread.id);
      }

      return context.prisma.groundThreads.update({
        where: { id: thread.id },
        data: {
          reviewState: transition.next,
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewNote: args.note ?? null,
          ...(promotedSignalId ? { promotedSignalId } : {}),
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
