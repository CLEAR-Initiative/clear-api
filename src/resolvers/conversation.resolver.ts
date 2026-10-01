/**
 * CLEAR Agent Conversations (ADR-0009).
 *
 * clear-mvp's Mastra memory adapter writes every Thread here through these
 * operations, forwarding the signed-in user's cookie, so every check below
 * runs as that user. Ids are caller-supplied because Mastra mints thread
 * and message ids before the first write.
 *
 * Access: an approved user reads and writes only their own Conversations.
 * There is no delete — a Conversation is the audit record of what the Agent
 * said.
 */

import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";
import { requireContentReader } from "../utils/auth-guard.js";

/** Mastra ids are UUIDs; anything much longer is not one of ours. */
const MAX_ID_LENGTH = 128;
/** One Agent turn writes a handful of messages; this only stops abuse. */
const MAX_MESSAGES_PER_CALL = 200;

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

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
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
      if (conversation.userId !== user.id) {
        throw forbidden("This Conversation belongs to another user");
      }
      return conversation;
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
  },

  Conversation: {
    messages: (parent: { id: string }, _args: unknown, context: Context) =>
      context.prisma.conversationMessages.findMany({
        where: { conversationId: parent.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
  },
};
