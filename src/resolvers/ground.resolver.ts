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
import {
  GROUND_SOURCE_KINDS,
  missingConsentFields,
} from "../services/ground-sources.js";

/** Callers of the pipeline-facing contract surface (the
 * classify_ground_messages worker authenticates as a pipeline-role
 * API-key user; platform admins pass for manual poking). */
const PIPELINE_ROLES = ["admin", "pipeline"];

const GROUND_CLASSIFICATIONS = new Set([
  "field_report",
  "news_digest",
  "operational",
  "chatter",
]);

const GROUND_LIFECYCLE_STATES = new Set([
  "reported",
  "updated",
  "confirmed",
  "corrected",
  "retracted",
]);

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

    /**
     * PIPELINE CONTRACT: the classification/threading worker's read
     * surface. Projects staged messages WITHOUT private-tier identity
     * (no senderName — only the pseudonymous senderRef). Returns all
     * messages for the source, oldest first, so the worker can both
     * label unclassified rows and assemble incident threads with full
     * context.
     */
    groundMessagesForClassification: async (
      _parent: unknown,
      args: { groundSourceId: string; limit?: number | null },
      context: Context,
    ) => {
      requireRole(context, PIPELINE_ROLES);
      const rows = await context.prisma.groundMessages.findMany({
        where: { groundSourceId: args.groundSourceId },
        orderBy: { sentAt: "asc" },
        take: Math.min(args.limit ?? 500, 2000),
      });
      return rows.map((m) => ({
        id: m.id,
        text: m.text,
        sentAt: m.sentAt,
        senderRef: m.senderRef,
        hasMedia:
          m.mediaKeys.length > 0 || m.mediaRefs.length > 0 || m.omittedMediaCount > 0,
        classification: m.classification,
        threadId: m.threadId,
      }));
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
      // Policy-record CRUD is admin-only as of V2 (was admin/analyst in
      // V1): consent records gate live capture, so writing them is a
      // platform-admin responsibility. Analysts keep full read + review.
      requireRole(context, ["admin"]);
      const { input } = args;

      if (!GROUND_SOURCE_KINDS.has(input.kind)) {
        throw new GraphQLError(
          `kind must be one of: ${[...GROUND_SOURCE_KINDS].join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const consent = {
        consentScope: input.consentScope ?? null,
        consentRecordedAt: input.consentRecordedAt
          ? new Date(input.consentRecordedAt)
          : null,
        consentRecordedBy: input.consentRecordedBy ?? null,
      };
      const missing = missingConsentFields(input.kind, consent);
      if (missing.length > 0) {
        throw new GraphQLError(
          `A ${input.kind} source requires a complete consent record — missing: ${missing.join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      return context.prisma.groundSources.create({
        data: {
          name: input.name,
          kind: input.kind,
          transportId: input.transportId,
          ...consent,
          privacyDefault: input.privacyDefault ?? "private",
          ...(input.reviewerRoles ? { reviewerRoles: input.reviewerRoles } : {}),
          retentionRule: input.retentionRule ?? null,
        },
      });
    },

    /**
     * Partial update of a ground source's policy record (admin only).
     * transportId is immutable — it is the identity externalIds are
     * minted against ("whatsapp:{jid}:{messageId}"); re-binding a source
     * to another group would corrupt idempotency, so that case is a new
     * source. The MERGED row is re-validated: a group-kind source cannot
     * be edited into (or left in) a state without a complete consent
     * record — a legacy row missing consent fields must have them
     * supplied in the same update.
     */
    updateGroundSource: async (
      _parent: unknown,
      args: {
        id: string;
        input: {
          name?: string | null;
          kind?: string | null;
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
      requireRole(context, ["admin"]);
      const { input } = args;

      const existing = await context.prisma.groundSources.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Ground source not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (input.kind != null && !GROUND_SOURCE_KINDS.has(input.kind)) {
        throw new GraphQLError(
          `kind must be one of: ${[...GROUND_SOURCE_KINDS].join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Null/omitted input fields leave the stored value unchanged.
      const merged = {
        kind: input.kind ?? existing.kind,
        consentScope: input.consentScope ?? existing.consentScope,
        consentRecordedAt: input.consentRecordedAt
          ? new Date(input.consentRecordedAt)
          : existing.consentRecordedAt,
        consentRecordedBy: input.consentRecordedBy ?? existing.consentRecordedBy,
      };
      const missing = missingConsentFields(merged.kind, merged);
      if (missing.length > 0) {
        throw new GraphQLError(
          `A ${merged.kind} source requires a complete consent record — missing: ${missing.join(", ")}`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      return context.prisma.groundSources.update({
        where: { id: existing.id },
        data: {
          ...(input.name != null ? { name: input.name } : {}),
          kind: merged.kind,
          consentScope: merged.consentScope,
          consentRecordedAt: merged.consentRecordedAt,
          consentRecordedBy: merged.consentRecordedBy,
          ...(input.privacyDefault != null
            ? { privacyDefault: input.privacyDefault }
            : {}),
          ...(input.reviewerRoles != null
            ? { reviewerRoles: input.reviewerRoles }
            : {}),
          ...(input.retentionRule != null
            ? { retentionRule: input.retentionRule }
            : {}),
        },
      });
    },

    /**
     * Activate/deactivate a ground source (admin only). Deactivation is
     * the kill switch: the live-ingest consent gate rejects every payload
     * for an inactive source, and export upload refuses it too. Kept as
     * an explicit mutation (not an update field) so flipping capture off
     * never has to pass consent-record validation — an incomplete legacy
     * row must still be deactivatable immediately.
     */
    setGroundSourceActive: async (
      _parent: unknown,
      args: { id: string; isActive: boolean },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.groundSources.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("Ground source not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.groundSources.update({
        where: { id: existing.id },
        data: { isActive: args.isActive },
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

    /**
     * PIPELINE CONTRACT: classification write-back from the
     * classify_ground_messages worker. Unknown messageIds are skipped
     * with a warning (a message can be deleted between read and write —
     * the batch must not fail for it). A null/omitted uncertaintyMarker
     * leaves the ingest-extracted marker untouched; a non-null one
     * overwrites it. Returns the number of rows updated.
     */
    upsertGroundMessageClassifications: async (
      _parent: unknown,
      args: {
        inputs: Array<{
          messageId: string;
          classification: string;
          uncertaintyMarker?: string | null;
        }>;
      },
      context: Context,
    ) => {
      requireRole(context, PIPELINE_ROLES);
      const { inputs } = args;
      if (inputs.length === 0) return 0;

      for (const input of inputs) {
        if (!GROUND_CLASSIFICATIONS.has(input.classification)) {
          throw new GraphQLError(
            `classification must be one of: ${[...GROUND_CLASSIFICATIONS].join(", ")}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }

      const existing = await context.prisma.groundMessages.findMany({
        where: { id: { in: inputs.map((i) => i.messageId) } },
        select: { id: true },
      });
      const known = new Set(existing.map((row) => row.id));

      const valid = inputs.filter((i) => known.has(i.messageId));
      if (valid.length < inputs.length) {
        console.warn(
          `[upsertGroundMessageClassifications] skipping ${inputs.length - valid.length} unknown messageId(s)`,
        );
      }
      if (valid.length === 0) return 0;

      await context.prisma.$transaction(
        valid.map((input) =>
          context.prisma.groundMessages.update({
            where: { id: input.messageId },
            data: {
              classification: input.classification,
              ...(input.uncertaintyMarker != null
                ? { uncertainty: input.uncertaintyMarker }
                : {}),
            },
          }),
        ),
      );
      return valid.length;
    },

    /**
     * PIPELINE CONTRACT: replace placeholder threading with the
     * worker's incident clustering. Per input: create a thread, point
     * the given messages at it, delete placeholder threads that became
     * empty. The human review gate outranks the pipeline: a message
     * whose current thread is no longer "unverified" (or has been
     * promoted) is never re-threaded, and only unverified, unpromoted,
     * now-empty threads are deleted. Returns one thread id per input in
     * order — null where an input had no movable messages.
     */
    upsertGroundThreads: async (
      _parent: unknown,
      args: {
        inputs: Array<{
          groundSourceId: string;
          title: string;
          lifecycleState: string;
          messageIds: string[];
        }>;
      },
      context: Context,
    ) => {
      requireRole(context, PIPELINE_ROLES);
      const { inputs } = args;
      if (inputs.length === 0) return [];

      for (const input of inputs) {
        if (!GROUND_LIFECYCLE_STATES.has(input.lifecycleState)) {
          throw new GraphQLError(
            `lifecycleState must be one of: ${[...GROUND_LIFECYCLE_STATES].join(", ")}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
        if (input.messageIds.length === 0) {
          throw new GraphQLError("messageIds must not be empty", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
      }

      return context.prisma.$transaction(
        async (tx) => {
          const threadIds: Array<string | null> = [];

          for (const input of inputs) {
            // Scoped to the input's source: ids from another source (or
            // unknown ids) simply don't match and are left alone.
            const messages = await tx.groundMessages.findMany({
              where: {
                id: { in: input.messageIds },
                groundSourceId: input.groundSourceId,
              },
              select: {
                id: true,
                thread: {
                  select: { id: true, reviewState: true, promotedSignalId: true },
                },
              },
            });

            const movable = messages.filter(
              (m) =>
                !m.thread ||
                (m.thread.reviewState === "unverified" && !m.thread.promotedSignalId),
            );
            if (movable.length < input.messageIds.length) {
              console.warn(
                `[upsertGroundThreads] "${input.title}": ${input.messageIds.length - movable.length} of ${input.messageIds.length} message(s) not re-threaded (unknown, wrong source, or already reviewed)`,
              );
            }
            if (movable.length === 0) {
              threadIds.push(null);
              continue;
            }

            const thread = await tx.groundThreads.create({
              data: {
                groundSourceId: input.groundSourceId,
                title: input.title,
                lifecycleState: input.lifecycleState,
              },
            });
            await tx.groundMessages.updateMany({
              where: { id: { in: movable.map((m) => m.id) } },
              data: { threadId: thread.id },
            });

            const vacatedThreadIds = [
              ...new Set(
                movable
                  .map((m) => m.thread?.id)
                  .filter((id): id is string => Boolean(id)),
              ),
            ];
            if (vacatedThreadIds.length > 0) {
              await tx.groundThreads.deleteMany({
                where: {
                  id: { in: vacatedThreadIds },
                  reviewState: "unverified",
                  promotedSignalId: null,
                  messages: { none: {} },
                },
              });
            }

            threadIds.push(thread.id);
          }

          return threadIds;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
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
