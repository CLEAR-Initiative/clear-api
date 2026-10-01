/**
 * CLEAR Agent Conversations (ADR-0009).
 *
 * clear-mvp's Mastra memory adapter writes every Thread here through these
 * operations, forwarding the signed-in user's cookie, so every check below
 * runs as that user. Ids are caller-supplied because Mastra mints thread
 * and message ids before the first write.
 *
 * Access: an approved user reads and writes their own Conversations.
 * Platform admins can read anyone's, read-only, and every such read is
 * logged as `conversation.admin_read`. There is no delete — a Conversation
 * is the audit record of what the Agent said.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { logActivity } from "../utils/activity-log.js";
import { env } from "../utils/env.js";
import {
  canSeeUserPrivate,
  requireContentReader,
  requireRole,
} from "../utils/auth-guard.js";

/** Mastra ids are UUIDs; anything much longer is not one of ours. */
const MAX_ID_LENGTH = 128;
/** One Agent turn writes a handful of messages; this only stops abuse. */
const MAX_MESSAGES_PER_CALL = 200;
const MAX_CONVERSATIONS_PAGE = 100;
const MAX_MESSAGES_WINDOW = 500;

type User = NonNullable<Context["user"]>;

interface UpsertConversationInput {
  id: string;
  title?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
}

interface ConversationMessageInput {
  id: string;
  role: string;
  type?: string | null;
  content: unknown;
  createdAt?: string | Date | null;
}

interface ConversationTurnUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the current UTC day: the Agent budget's reset boundary. */
function utcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
}

function pageSize(first: number | null | undefined): number {
  const size = first ?? 20;
  if (size < 1 || size > MAX_CONVERSATIONS_PAGE) {
    throw badInput(`first must be 1–${MAX_CONVERSATIONS_PAGE}`);
  }
  return size;
}

/** One page of a user's Conversations, most recently active first. */
function listConversations(
  context: Context,
  userId: string,
  args: { first?: number | null; after?: string | null },
) {
  // `id` breaks updatedAt ties so the cursor is stable. `after` = the last
  // id of the previous page; skip:1 steps past it.
  return context.prisma.conversations.findMany({
    where: { userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: pageSize(args.first),
    ...(args.after ? { cursor: { id: args.after }, skip: 1 } : {}),
  });
}

function assertId(id: string, what: string): void {
  if (!id || id.length > MAX_ID_LENGTH) {
    throw badInput(`${what} id must be 1–${MAX_ID_LENGTH} characters`);
  }
}

/**
 * Load a Conversation the caller may write to. Writes are owner-only:
 * platform admins read Conversations but never change them.
 */
async function loadWritableConversation(
  context: Context,
  user: User,
  id: string,
) {
  const conversation = await context.prisma.conversations.findUnique({
    where: { id },
  });
  if (!conversation) {
    throw new GraphQLError("Conversation not found", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  if (conversation.userId !== user.id) {
    throw forbidden("Only the owner can change a Conversation");
  }
  return conversation;
}

export const conversationResolvers = {
  Query: {
    conversation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const conversation = await context.prisma.conversations.findUnique({
        where: { id: args.id },
      });
      if (!conversation) return null;
      // Self or platform admin; sharing a team or org is not enough.
      if (!canSeeUserPrivate(context, conversation.userId)) {
        throw forbidden("This Conversation belongs to another user");
      }
      if (conversation.userId !== user.id) {
        void logActivity(context.prisma, {
          userId: user.id,
          action: "conversation.admin_read",
          resourceType: "conversation",
          resourceId: conversation.id,
          metadata: { ownerId: conversation.userId },
        });
      }
      return conversation;
    },

    myConversations: (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      return listConversations(context, user.id, args);
    },

    myAgentBudget: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const since = utcMidnight(new Date());
      // Summed by usageRecordedAt (server time), never the caller-supplied
      // createdAt, so a back-dated message can't escape today's budget.
      const spent = await context.prisma.conversationMessages.aggregate({
        where: {
          conversation: { userId: user.id },
          usageRecordedAt: { gte: since },
        },
        _sum: { costUsd: true },
      });
      return {
        limitUsd: env.AGENT_DAILY_BUDGET_USD,
        spentTodayUsd: spent._sum.costUsd ?? 0,
        resetsAt: new Date(since.getTime() + DAY_MS),
      };
    },

    userConversations: (
      _parent: unknown,
      args: { userId: string; first?: number | null; after?: string | null },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);
      const page = listConversations(context, args.userId, args);
      if (args.userId !== admin.id) {
        void logActivity(context.prisma, {
          userId: admin.id,
          action: "conversation.admin_read",
          resourceType: "conversation",
          metadata: { ownerId: args.userId, listing: true },
        });
      }
      return page;
    },
  },

  Mutation: {
    upsertConversation: async (
      _parent: unknown,
      args: { input: UpsertConversationInput },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const { id, title, metadata, createdAt } = args.input;
      assertId(id, "Conversation");

      const existing = await context.prisma.conversations.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (existing && existing.userId !== user.id) {
        throw forbidden("This Conversation belongs to another user");
      }

      // Omitted fields stay as they are; an explicit null clears them.
      const changes = {
        ...(title !== undefined ? { title } : {}),
        ...(metadata !== undefined
          ? { metadata: (metadata ?? undefined) as InputJsonValue | undefined }
          : {}),
      };
      if (existing) {
        return context.prisma.conversations.update({
          where: { id },
          data: changes,
        });
      }
      return context.prisma.conversations.create({
        data: {
          id,
          userId: user.id,
          ...changes,
          ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        },
      });
    },

    upsertConversationMessages: async (
      _parent: unknown,
      args: { conversationId: string; messages: ConversationMessageInput[] },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const { conversationId, messages } = args;
      if (messages.length > MAX_MESSAGES_PER_CALL) {
        throw badInput(
          `At most ${MAX_MESSAGES_PER_CALL} messages can be written per call`,
        );
      }
      for (const message of messages) {
        assertId(message.id, "Message");
        if (!message.role) throw badInput("Message role is required");
      }
      await loadWritableConversation(context, user, conversationId);
      if (messages.length === 0) return [];

      // A message id already used in another Conversation (possibly another
      // user's) must never be overwritten through this one.
      const ids = messages.map((m) => m.id);
      const elsewhere = await context.prisma.conversationMessages.findFirst({
        where: { id: { in: ids }, conversationId: { not: conversationId } },
        select: { id: true },
      });
      if (elsewhere) {
        throw forbidden(
          `Message ${elsewhere.id} belongs to another Conversation`,
        );
      }

      const writes = messages.map((m) => {
        const createdAt = m.createdAt ? new Date(m.createdAt) : undefined;
        const fields = {
          role: m.role,
          type: m.type ?? null,
          content: m.content as InputJsonValue,
        };
        return context.prisma.conversationMessages.upsert({
          where: { id: m.id },
          create: { id: m.id, conversationId, ...fields, createdAt },
          update: { ...fields, ...(createdAt ? { createdAt } : {}) },
        });
      });
      // Touch the Conversation so "newest first" means "most recently active".
      const touch = context.prisma.conversations.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      const results = await context.prisma.$transaction([...writes, touch]);
      return results.slice(0, writes.length);
    },

    recordConversationTurnUsage: async (
      _parent: unknown,
      args: { messageId: string; usage: ConversationTurnUsageInput },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      const { model, inputTokens, outputTokens, costUsd, latencyMs } =
        args.usage;
      if (!model) throw badInput("model is required");
      for (const [name, value] of Object.entries({
        inputTokens,
        outputTokens,
        latencyMs,
      })) {
        if (!Number.isInteger(value) || value < 0) {
          throw badInput(`${name} must be a non-negative integer`);
        }
      }
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        throw badInput("costUsd must be a non-negative number");
      }

      const message = await context.prisma.conversationMessages.findUnique({
        where: { id: args.messageId },
        select: {
          role: true,
          usageRecordedAt: true,
          conversation: { select: { userId: true } },
        },
      });
      if (!message) {
        throw new GraphQLError("Message not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (message.conversation.userId !== user.id) {
        throw forbidden("Only the owner can change a Conversation");
      }
      if (message.role !== "assistant") {
        throw badInput("Usage is recorded on assistant messages only");
      }
      return context.prisma.conversationMessages.update({
        where: { id: args.messageId },
        data: {
          model,
          inputTokens,
          outputTokens,
          costUsd,
          latencyMs,
          // A correction keeps the turn on the day it was first charged.
          usageRecordedAt: message.usageRecordedAt ?? new Date(),
        },
      });
    },
  },

  // Field resolvers inherit access from the parent: a Conversation object is
  // only ever returned to someone allowed to read it.
  Conversation: {
    messageCount: (parent: { id: string }, _args: unknown, context: Context) =>
      context.prisma.conversationMessages.count({
        where: { conversationId: parent.id },
      }),

    messages: async (
      parent: { id: string },
      args: { first?: number | null; before?: string | null },
      context: Context,
    ) => {
      const { first, before } = args;
      if (first != null && (first < 1 || first > MAX_MESSAGES_WINDOW)) {
        throw badInput(`first must be 1–${MAX_MESSAGES_WINDOW}`);
      }
      let olderThan = {};
      if (before) {
        const anchor = await context.prisma.conversationMessages.findUnique({
          where: { id: before },
          select: { conversationId: true, createdAt: true },
        });
        if (!anchor || anchor.conversationId !== parent.id) {
          throw badInput("before must be a message in this Conversation");
        }
        olderThan = {
          OR: [
            { createdAt: { lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { lt: before } },
          ],
        };
      }
      // Newest first so `take` keeps the most recent window, then flip back
      // to chronological order.
      const rows = await context.prisma.conversationMessages.findMany({
        where: { conversationId: parent.id, ...olderThan },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(first != null ? { take: first } : {}),
      });
      return rows.reverse();
    },
  },
};
