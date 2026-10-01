/**
 * Unit tests for `conversation.resolver.ts`.
 *
 * DB-free: `context.prisma.conversations` / `conversationMessages` are stubbed
 * per test. Covers the auth matrix (unauthenticated / pending / owner / other
 * user) for every operation and the id-ownership rules on upserts.
 */

import { describe, it, expect, vi } from "vitest";
import { conversationResolvers } from "../../src/resolvers/conversation.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

interface PrismaStub {
  conversations?: Record<string, unknown>;
  conversationMessages?: Record<string, unknown>;
  $transaction?: unknown;
}

function buildContext(user: User, prisma: PrismaStub = {}): Context {
  return {
    prisma: {
      conversations: {},
      conversationMessages: {},
      $transaction: (ops: unknown[]) => Promise.all(ops),
      ...prisma,
    } as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const OWNER = { id: "u1", role: "viewer" };
const OTHER = { id: "u2", role: "analyst" };
const PENDING = { id: "u3", role: "pending" };

const { conversation } = conversationResolvers.Query;
const { upsertConversation, upsertConversationMessages } =
  conversationResolvers.Mutation;
const { messages } = conversationResolvers.Conversation;

const owned = { id: "t1", userId: "u1", title: null, metadata: null };

describe("Query.conversation", () => {
  it("returns the owner's Conversation", async () => {
    const findUnique = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, { conversations: { findUnique } });
    await expect(conversation(null, { id: "t1" }, ctx)).resolves.toBe(owned);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("returns null when no Conversation has the id", async () => {
    const ctx = buildContext(OWNER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(conversation(null, { id: "nope" }, ctx)).resolves.toBeNull();
  });

  it("is FORBIDDEN for another user", async () => {
    const ctx = buildContext(OTHER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
    });
    await expect(conversation(null, { id: "t1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("is FORBIDDEN for a pending user, before any lookup", async () => {
    const findUnique = vi.fn();
    const ctx = buildContext(PENDING, { conversations: { findUnique } });
    await expect(conversation(null, { id: "t1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN", subCode: "PENDING_APPROVAL" },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is UNAUTHENTICATED without a session", async () => {
    await expect(
      conversation(null, { id: "t1" }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Mutation.upsertConversation", () => {
  it("creates a Conversation with the caller-supplied id for the caller", async () => {
    const create = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    await upsertConversation(
      null,
      {
        input: {
          id: "t1",
          title: "Darfur access",
          metadata: { a: 1 },
          createdAt: "2026-10-01T08:00:00.000Z",
        },
      },
      ctx,
    );
    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({
      id: "t1",
      userId: "u1",
      title: "Darfur access",
      metadata: { a: 1 },
    });
    expect(data.createdAt.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("updates only the fields supplied", async () => {
    const update = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue({ userId: "u1" }),
        update,
      },
    });
    await upsertConversation(null, { input: { id: "t1", title: "New" } }, ctx);
    expect(update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { title: "New" },
    });
  });

  it("is FORBIDDEN when the id belongs to another user, and writes nothing", async () => {
    const update = vi.fn();
    const create = vi.fn();
    const ctx = buildContext(OTHER, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue({ userId: "u1" }),
        update,
        create,
      },
    });
    await expect(
      upsertConversation(null, { input: { id: "t1", title: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an over-long id", async () => {
    const ctx = buildContext(OWNER);
    await expect(
      upsertConversation(null, { input: { id: "x".repeat(129) } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("is FORBIDDEN for a pending user", async () => {
    await expect(
      upsertConversation(null, { input: { id: "t1" } }, buildContext(PENDING)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("is UNAUTHENTICATED without a session", async () => {
    await expect(
      upsertConversation(null, { input: { id: "t1" } }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Mutation.upsertConversationMessages", () => {
  const userTurn = {
    id: "m1",
    role: "user",
    type: "v2",
    content: { format: 2, parts: [{ type: "text", text: "Hi" }] },
    createdAt: "2026-10-01T08:00:00.000Z",
  };

  function ownerContext(extra: Record<string, unknown> = {}) {
    const upsert = vi.fn(async (args: { create: unknown }) => args.create);
    const touch = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue(owned),
        update: touch,
      },
      conversationMessages: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert,
        ...extra,
      },
    });
    return { ctx, upsert, touch };
  }

  it("upserts each message by id and touches the Conversation", async () => {
    const { ctx, upsert, touch } = ownerContext();
    const result = await upsertConversationMessages(
      null,
      { conversationId: "t1", messages: [userTurn] },
      ctx,
    );
    const call = upsert.mock.calls[0][0] as unknown as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "m1" });
    expect(call.create).toMatchObject({
      id: "m1",
      conversationId: "t1",
      role: "user",
      type: "v2",
      content: userTurn.content,
    });
    expect((call.create.createdAt as Date).toISOString()).toBe(
      userTurn.createdAt,
    );
    expect(call.update).toMatchObject({ role: "user", content: userTurn.content });
    expect(touch.mock.calls[0][0].where).toEqual({ id: "t1" });
    expect(result).toHaveLength(1);
  });

  it("is FORBIDDEN when a message id belongs to another Conversation", async () => {
    const { ctx, upsert } = ownerContext({
      findFirst: vi.fn().mockResolvedValue({ id: "m1" }),
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for another user, and writes nothing", async () => {
    const upsert = vi.fn();
    const ctx = buildContext(OTHER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
      conversationMessages: { upsert },
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND when the Conversation does not exist", async () => {
    const ctx = buildContext(OWNER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t9", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("rejects more than 200 messages per call", async () => {
    const { ctx } = ownerContext();
    const many = Array.from({ length: 201 }, (_, i) => ({ ...userTurn, id: `m${i}` }));
    await expect(
      upsertConversationMessages(null, { conversationId: "t1", messages: many }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("is FORBIDDEN for a pending user", async () => {
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        buildContext(PENDING),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("is UNAUTHENTICATED without a session", async () => {
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        buildContext(null),
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Conversation.messages", () => {
  it("lists the Conversation's messages chronologically", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(OWNER, { conversationMessages: { findMany } });
    await messages({ id: "t1" }, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { conversationId: "t1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });
});
