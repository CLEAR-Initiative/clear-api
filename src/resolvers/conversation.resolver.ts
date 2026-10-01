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
 *
 * Also here: the Agent's per-user working memory (Mastra's "resource") and
 * the daily Agent budget, both strictly the caller's own.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { logActivityOrThrow } from "../utils/activity-log.js";
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
/** Working memory is a short Markdown profile, not a document store. */
const MAX_WORKING_MEMORY_LENGTH = 100_000;
/** One message, Source documents included, serialised. Generous for an
 *  Answer citing a dozen NRC Find passages; stops a 50 MB body. */
const MAX_MESSAGE_CONTENT_LENGTH = 1_000_000;
const MAX_METADATA_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 500;
/** role and type are short tags (`assistant`, `v2`). */
const MAX_TAG_LENGTH = 32;

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

interface SaveAgentWorkingMemoryInput {
  workingMemory?: string | null;
  metadata?: unknown;
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

/** A JSON column write where an explicit null means SQL NULL. */
function jsonOrDbNull(value: unknown): InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as InputJsonValue);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
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

/**
 * A Conversation's position in "most recently active first" order. It
 * carries the sort values rather than just the id: updatedAt moves whenever
 * a Thread is continued, so an id cursor would jump to the top of the list
 * and repeat a page.
 */
export function encodeConversationCursor(c: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${c.updatedAt.toISOString()}|${c.id}`).toString("base64url");
}

function decodeConversationCursor(cursor: string): { updatedAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.indexOf("|");
  const updatedAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (sep < 0 || Number.isNaN(updatedAt.getTime()) || !id) {
    throw badInput("after must be a Conversation cursor");
  }
  return { updatedAt, id };
}

/** One page of a user's Conversations, most recently active first. */
function listConversations(
  context: Context,
  userId: string,
  args: { first?: number | null; after?: string | null },
) {
  const take = pageSize(args.first);
  // `id` breaks updatedAt ties so the order is total.
  let olderThan = {};
  if (args.after) {
    const { updatedAt, id } = decodeConversationCursor(args.after);
    olderThan = {
      OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: id } }],
    };
  }
  return context.prisma.conversations.findMany({
    where: { userId, ...olderThan },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take,
  });
}

function assertMaxLength(
  value: string | null | undefined,
  max: number,
  what: string,
): void {
  if (value && value.length > max) {
    throw badInput(`${what} must be at most ${max} characters`);
  }
}

/** Size of a JSON value as stored, so one write can't be arbitrarily large. */
function assertJsonSize(value: unknown, max: number, what: string): void {
  if (value != null && JSON.stringify(value).length > max) {
    throw badInput(`${what} must be at most ${max} characters as JSON`);
  }
}

function assertId(id: string, what: string): void {
  if (!id || id.length > MAX_ID_LENGTH) {
    throw badInput(`${what} id must be 1–${MAX_ID_LENGTH} characters`);
  }
}

/**
 * Gate for every write. A Conversation is the record of what the CLEAR Agent
 * told its owner, so only the Agent writes it: the request must carry the
 * owner's session (who it is for) AND the `agent` service key (that it comes
 * from clear-mvp's Agent, not from the owner calling the API directly). An
 * API key alone, or the owner's session alone, is not enough.
 */
function requireConversationWriter(context: Context): User {
  const user = requireContentReader(context);
  if (context.authMethod !== "session" || !context.viaAgent) {
    throw forbidden("Conversations are written only by the CLEAR Agent in the app");
  }
  return user;
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
      // The read is only served once it is on the audit log.
      if (conversation.userId !== user.id) {
        await logActivityOrThrow(context.prisma, {
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

    conversationMessagesByIds: async (
      _parent: unknown,
      args: { ids: string[] },
      context: Context,
    ) => {
      const user = requireContentReader(context);
      if (args.ids.length > MAX_MESSAGES_PER_CALL) {
        throw badInput(`At most ${MAX_MESSAGES_PER_CALL} ids per call`);
      }
      if (args.ids.length === 0) return [];
      // Only the caller's own: other users' ids are silently absent, so the
      // result never confirms that someone else's message exists.
      return context.prisma.conversationMessages.findMany({
        where: { id: { in: args.ids }, conversation: { userId: user.id } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
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

    myAgentWorkingMemory: (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      const user = requireContentReader(context);
      return context.prisma.agentWorkingMemory.findUnique({
        where: { userId: user.id },
      });
    },

    userConversations: async (
      _parent: unknown,
      args: { userId: string; first?: number | null; after?: string | null },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);
      const page = await listConversations(context, args.userId, args);
      // Log exactly which Conversations were handed over, before returning.
      if (args.userId !== admin.id && page.length > 0) {
        await logActivityOrThrow(context.prisma, {
          userId: admin.id,
          action: "conversation.admin_read",
          resourceType: "conversation",
          metadata: {
            ownerId: args.userId,
            listing: true,
            conversationIds: page.map((c) => c.id),
          },
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
      const user = requireConversationWriter(context);
      const { id, title, metadata, createdAt } = args.input;
      assertId(id, "Conversation");
      assertMaxLength(title, MAX_TITLE_LENGTH, "title");
      assertJsonSize(metadata, MAX_METADATA_LENGTH, "metadata");

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
          ? { metadata: jsonOrDbNull(metadata) }
          : {}),
      };
      if (existing) {
        return context.prisma.conversations.update({
          where: { id },
          data: changes,
        });
      }
      try {
        return await context.prisma.conversations.create({
          data: {
            id,
            userId: user.id,
            ...changes,
            ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
          },
        });
      } catch (err) {
        // Lost a create race for the same id (a double submit, or the Agent's
        // get-or-create running twice): settle on the row that won.
        if (!isUniqueViolation(err)) throw err;
        const winner = await context.prisma.conversations.findUnique({
          where: { id },
          select: { userId: true },
        });
        if (winner?.userId !== user.id) {
          throw forbidden("This Conversation belongs to another user");
        }
        return context.prisma.conversations.update({
          where: { id },
          data: changes,
        });
      }
    },

    upsertConversationMessages: async (
      _parent: unknown,
      args: { conversationId: string; messages: ConversationMessageInput[] },
      context: Context,
    ) => {
      const user = requireConversationWriter(context);
      const { conversationId, messages } = args;
      if (messages.length > MAX_MESSAGES_PER_CALL) {
        throw badInput(
          `At most ${MAX_MESSAGES_PER_CALL} messages can be written per call`,
        );
      }
      for (const message of messages) {
        assertId(message.id, "Message");
        if (!message.role) throw badInput("Message role is required");
        assertMaxLength(message.role, MAX_TAG_LENGTH, "role");
        assertMaxLength(message.type, MAX_TAG_LENGTH, "type");
        assertJsonSize(message.content, MAX_MESSAGE_CONTENT_LENGTH, "content");
      }
      await loadWritableConversation(context, user, conversationId);
      if (messages.length === 0) return [];

      const ids = messages.map((m) => m.id);
      const existing = await context.prisma.conversationMessages.findMany({
        where: { id: { in: ids } },
        select: { id: true, conversationId: true, usageRecordedAt: true },
      });
      for (const row of existing) {
        // A message id already used in another Conversation (possibly
        // another user's) must never be overwritten through this one.
        if (row.conversationId !== conversationId) {
          throw forbidden(`Message ${row.id} belongs to another Conversation`);
        }
        // Once a turn is charged its Answer is the record of what the Agent
        // said; it can't be rewritten afterwards.
        if (row.usageRecordedAt) {
          throw forbidden(`Message ${row.id} is a recorded Answer and can't change`);
        }
      }

      return context.prisma.$transaction(
        async (tx) => {
          // Timestamps go in as UTC text, the way Prisma stores them in these
          // timezone-less columns, so the session timezone can't shift them.
          const now = new Date().toISOString();
          for (const m of messages) {
            const createdAt = m.createdAt
              ? new Date(m.createdAt).toISOString()
              : null;
            // The checks above give a precise error; this makes them atomic.
            // A conflicting id is updated only if it is in this Conversation
            // and not yet charged, in the same statement as the insert. A
            // concurrent write of the same new id in this Conversation waits
            // and then updates, so retries stay idempotent.
            const written = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO conversation_messages
                (id, conversation_id, role, type, content, created_at, updated_at)
              VALUES (
                ${m.id}, ${conversationId}, ${m.role}, ${m.type ?? null},
                ${JSON.stringify(m.content)}::jsonb,
                COALESCE(${createdAt}::timestamp, ${now}::timestamp),
                ${now}::timestamp
              )
              ON CONFLICT (id) DO UPDATE SET
                role = EXCLUDED.role,
                type = EXCLUDED.type,
                content = EXCLUDED.content,
                created_at = COALESCE(${createdAt}::timestamp, conversation_messages.created_at),
                updated_at = EXCLUDED.updated_at
              WHERE conversation_messages.conversation_id = ${conversationId}
                AND conversation_messages.usage_recorded_at IS NULL
              RETURNING id`;
            // No row: the id was claimed elsewhere or charged in the meantime.
            // Throwing rolls back the whole batch.
            if (written.length === 0) {
              throw forbidden(
                `Message ${m.id} belongs to another Conversation or is a recorded Answer`,
              );
            }
          }
          // Touch the Conversation so "newest first" means "most recently active".
          await tx.conversations.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });
          const rows = await tx.conversationMessages.findMany({
            where: { id: { in: ids } },
          });
          const byId = new Map(rows.map((row) => [row.id, row]));
          return messages.map((m) => byId.get(m.id)!);
        },
        // One statement per message, up to MAX_MESSAGES_PER_CALL of them:
        // more than Prisma's 5s interactive default allows for on a slow link.
        { timeout: 15_000 },
      );
    },

    saveAgentWorkingMemory: (
      _parent: unknown,
      args: { input: SaveAgentWorkingMemoryInput },
      context: Context,
    ) => {
      const user = requireConversationWriter(context);
      const { workingMemory, metadata } = args.input;
      assertMaxLength(workingMemory, MAX_WORKING_MEMORY_LENGTH, "workingMemory");
      assertJsonSize(metadata, MAX_METADATA_LENGTH, "metadata");
      // Omitted fields stay as they are; an explicit null clears them.
      const changes = {
        ...(workingMemory !== undefined ? { workingMemory } : {}),
        ...(metadata !== undefined
          ? { metadata: jsonOrDbNull(metadata) }
          : {}),
      };
      return context.prisma.agentWorkingMemory.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...changes },
        update: changes,
      });
    },

    recordConversationTurnUsage: async (
      _parent: unknown,
      args: { messageId: string; usage: ConversationTurnUsageInput },
      context: Context,
    ) => {
      const user = requireConversationWriter(context);
      const { model, inputTokens, outputTokens, costUsd, latencyMs } =
        args.usage;
      if (!model) throw badInput("model is required");
      assertMaxLength(model, MAX_TITLE_LENGTH, "model");
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
      // Write-once, atomically: a turn is charged exactly once, so recorded
      // spend can never be lowered afterwards to reopen the budget.
      const { count } = await context.prisma.conversationMessages.updateMany({
        where: { id: args.messageId, usageRecordedAt: null },
        data: {
          model,
          inputTokens,
          outputTokens,
          costUsd,
          latencyMs,
          usageRecordedAt: new Date(),
        },
      });
      if (count === 0) {
        throw forbidden("Usage for this turn is already recorded");
      }
      return context.prisma.conversationMessages.findUniqueOrThrow({
        where: { id: args.messageId },
      });
    },
  },

  // Field resolvers inherit access from the parent: a Conversation object is
  // only ever returned to someone allowed to read it.
  Conversation: {
    cursor: (parent: { updatedAt: Date; id: string }) =>
      encodeConversationCursor(parent),

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
        take: first ?? MAX_MESSAGES_WINDOW,
      });
      return rows.reverse();
    },
  },
};
