/**
 * Unit tests for `conversation.resolver.ts`.
 *
 * DB-free: `context.prisma.conversations` / `conversationMessages` are stubbed
 * per test, and the activity-log writer is mocked. Covers the auth matrix
 * (unauthenticated / pending / owner / other user / admin) for every
 * operation, the logged admin read, admin write rejection, and the
 * id-ownership rules on upserts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivityOrThrow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/utils/env.js", () => ({
  env: { AGENT_DAILY_BUDGET_USD: 2.5 },
}));

import {
  conversationResolvers,
  encodeConversationCursor,
} from "../../src/resolvers/conversation.resolver.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { logActivityOrThrow as logActivity } from "../../src/utils/activity-log.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

interface PrismaStub {
  conversations?: Record<string, unknown>;
  conversationMessages?: Record<string, unknown>;
  agentWorkingMemory?: Record<string, unknown>;
  $transaction?: unknown;
  $queryRaw?: unknown;
}

function buildContext(
  user: User,
  prisma: PrismaStub = {},
  authMethod: "session" | "api-key" = "session",
): Context {
  const client: Record<string, unknown> = {
    conversations: {},
    conversationMessages: {},
    // Array form runs the ops; callback form runs against the same stubs.
    $transaction: (arg: unknown) =>
      typeof arg === "function" ? arg(client) : Promise.all(arg as unknown[]),
    ...prisma,
  };
  return {
    prisma: client as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? authMethod : null,
  } as Context;
}

const OWNER = { id: "u1", role: "viewer" };
const OTHER = { id: "u2", role: "analyst" };
const PENDING = { id: "u3", role: "pending" };
const ADMIN = { id: "a1", role: "admin" };

beforeEach(() => {
  vi.mocked(logActivity).mockClear();
});

const {
  conversation,
  myConversations,
  userConversations,
  myAgentBudget,
  myAgentWorkingMemory,
  conversationMessagesByIds,
} = conversationResolvers.Query;
const {
  upsertConversation,
  upsertConversationMessages,
  recordConversationTurnUsage,
  saveAgentWorkingMemory,
} = conversationResolvers.Mutation;
const { messages, messageCount } = conversationResolvers.Conversation;

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

  it("does not log the owner's own read", async () => {
    const ctx = buildContext(OWNER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
    });
    await conversation(null, { id: "t1" }, ctx);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("lets a platform admin read another user's Conversation, and logs it", async () => {
    const ctx = buildContext(ADMIN, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
    });
    await expect(conversation(null, { id: "t1" }, ctx)).resolves.toBe(owned);
    expect(logActivity).toHaveBeenCalledWith(ctx.prisma, {
      userId: "a1",
      action: "conversation.admin_read",
      resourceType: "conversation",
      resourceId: "t1",
      metadata: { ownerId: "u1" },
    });
  });

  it("serves nothing when the audit row can't be written", async () => {
    vi.mocked(logActivity).mockRejectedValueOnce(new Error("pool exhausted"));
    const ctx = buildContext(ADMIN, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
    });
    await expect(conversation(null, { id: "t1" }, ctx)).rejects.toThrow("pool exhausted");
  });

  it("does not log a read that found nothing", async () => {
    const ctx = buildContext(ADMIN, {
      conversations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await conversation(null, { id: "t1" }, ctx);
    expect(logActivity).not.toHaveBeenCalled();
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

  it("clears metadata to SQL NULL on an explicit null", async () => {
    const update = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue({ userId: "u1" }),
        update,
      },
    });
    await upsertConversation(null, { input: { id: "t1", metadata: null } }, ctx);
    expect(update.mock.calls[0][0].data).toEqual({ metadata: Prisma.DbNull });
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

  it("settles a lost create race on the caller's own row", async () => {
    const update = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ userId: "u1" }),
        create: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
          }),
        ),
        update,
      },
    });
    await expect(
      upsertConversation(null, { input: { id: "t1", title: "x" } }, ctx),
    ).resolves.toBe(owned);
    expect(update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { title: "x" } });
  });

  it("is FORBIDDEN when another user won the create race", async () => {
    const update = vi.fn();
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ userId: "u2" }),
        create: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
          }),
        ),
        update,
      },
    });
    await expect(
      upsertConversation(null, { input: { id: "t1" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for a platform admin on another user's Conversation", async () => {
    const update = vi.fn();
    const ctx = buildContext(ADMIN, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue({ userId: "u1" }),
        update,
      },
    });
    await expect(
      upsertConversation(null, { input: { id: "t1", title: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN with an API key", async () => {
    await expect(
      upsertConversation(null, { input: { id: "t1" } }, buildContext(OWNER, {}, "api-key")),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects an over-long title or oversized metadata", async () => {
    const ctx = buildContext(OWNER);
    await expect(
      upsertConversation(null, { input: { id: "t1", title: "x".repeat(501) } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      upsertConversation(
        null,
        { input: { id: "t1", metadata: { blob: "x".repeat(100_001) } } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
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

  function ownerContext(
    extra: Record<string, unknown> = {},
    { written = [{ id: "m1" }] }: { written?: { id: string }[] } = {},
  ) {
    const queryRaw = vi.fn().mockResolvedValue(written);
    const touch = vi.fn().mockResolvedValue(owned);
    const ctx = buildContext(OWNER, {
      conversations: {
        findUnique: vi.fn().mockResolvedValue(owned),
        update: touch,
      },
      conversationMessages: {
        // First call is the ownership check, second reads back the rows.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: "m1", conversationId: "t1" }]),
        ...extra,
      },
      $queryRaw: queryRaw,
    });
    return { ctx, queryRaw, touch };
  }

  it("writes each message in one conditional upsert and touches the Conversation", async () => {
    const { ctx, queryRaw, touch } = ownerContext();
    const result = await upsertConversationMessages(
      null,
      { conversationId: "t1", messages: [userTurn] },
      ctx,
    );
    expect(queryRaw).toHaveBeenCalledOnce();
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    // The ownership and finalization conditions live in the statement itself,
    // so they can't go stale between the check and the write.
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sql).toMatch(/WHERE conversation_messages\.conversation_id = \?\s+AND conversation_messages\.usage_recorded_at IS NULL/);
    expect(values).toEqual(
      expect.arrayContaining([
        "m1",
        "t1",
        "user",
        "v2",
        JSON.stringify(userTurn.content),
        userTurn.createdAt,
      ]),
    );
    expect(touch.mock.calls[0][0].where).toEqual({ id: "t1" });
    expect(result).toEqual([{ id: "m1", conversationId: "t1" }]);
  });

  it("is FORBIDDEN, and touches nothing, when the conditional write matches no row", async () => {
    // Claimed by another Conversation or charged after the precheck.
    const { ctx, touch } = ownerContext({}, { written: [] });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(touch).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN when a message id belongs to another Conversation", async () => {
    const { ctx, queryRaw } = ownerContext({
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "m1", conversationId: "other", usageRecordedAt: null }]),
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN to rewrite an Answer whose usage is recorded", async () => {
    const { ctx, queryRaw } = ownerContext({
      findMany: vi.fn().mockResolvedValue([
        { id: "m1", conversationId: "t1", usageRecordedAt: new Date() },
      ]),
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN with an API key, before any lookup", async () => {
    const findUnique = vi.fn();
    const ctx = buildContext(OWNER, { conversations: { findUnique } }, "api-key");
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for another user, and writes nothing", async () => {
    const queryRaw = vi.fn();
    const ctx = buildContext(OTHER, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
      $queryRaw: queryRaw,
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for a platform admin, and writes nothing", async () => {
    const queryRaw = vi.fn();
    const ctx = buildContext(ADMIN, {
      conversations: { findUnique: vi.fn().mockResolvedValue(owned) },
      $queryRaw: queryRaw,
    });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [userTurn] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(queryRaw).not.toHaveBeenCalled();
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

  it.each([
    ["oversized content", { content: { text: "x".repeat(1_000_001) } }],
    ["an over-long role", { role: "r".repeat(33) }],
    ["an over-long type", { type: "t".repeat(33) }],
  ])("rejects %s before any lookup", async (_name, bad) => {
    const { ctx } = ownerContext();
    const findUnique = vi.fn();
    (ctx.prisma.conversations as unknown as { findUnique: unknown }).findUnique = findUnique;
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: "t1", messages: [{ ...userTurn, ...bad }] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findUnique).not.toHaveBeenCalled();
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

describe("Query.myConversations", () => {
  it("lists only the caller's Conversations, most recently active first", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(OWNER, { conversations: { findMany } });
    await myConversations(null, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 20,
    });
  });

  it("pages strictly after the cursor's (updatedAt, id) position", async () => {
    const at = new Date("2026-10-01T08:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(OWNER, { conversations: { findMany } });
    const after = encodeConversationCursor({ updatedAt: at, id: "t9" });
    await myConversations(null, { first: 5, after }, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: "t9" } }],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 5,
    });
  });

  it("rejects a malformed cursor", () => {
    const ctx = buildContext(OWNER, { conversations: { findMany: vi.fn() } });
    expect(() => myConversations(null, { after: "t9" }, ctx)).toThrow(/cursor/);
  });

  it("scopes to the caller even for a platform admin", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext({ id: "a1", role: "admin" }, { conversations: { findMany } });
    await myConversations(null, {}, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: "a1" });
  });

  it("rejects first outside 1–100", () => {
    const ctx = buildContext(OWNER, { conversations: { findMany: vi.fn() } });
    expect(() => myConversations(null, { first: 0 }, ctx)).toThrow(/first/);
    expect(() => myConversations(null, { first: 101 }, ctx)).toThrow(/first/);
  });

  it("is FORBIDDEN for a pending user", () => {
    expect(() => myConversations(null, {}, buildContext(PENDING))).toThrow(
      /awaiting admin approval/,
    );
  });

  it("is UNAUTHENTICATED without a session", () => {
    expect(() => myConversations(null, {}, buildContext(null))).toThrow(
      /logged in/,
    );
  });
});

describe("Query.userConversations", () => {
  it("lists the target user's Conversations for an admin, and logs which", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    const ctx = buildContext(ADMIN, { conversations: { findMany } });
    await userConversations(null, { userId: "u1", first: 10 }, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 10,
    });
    expect(logActivity).toHaveBeenCalledWith(ctx.prisma, {
      userId: "a1",
      action: "conversation.admin_read",
      resourceType: "conversation",
      metadata: { ownerId: "u1", listing: true, conversationIds: ["t1", "t2"] },
    });
  });

  it("serves nothing when the audit row can't be written", async () => {
    vi.mocked(logActivity).mockRejectedValueOnce(new Error("pool exhausted"));
    const ctx = buildContext(ADMIN, {
      conversations: { findMany: vi.fn().mockResolvedValue([{ id: "t1" }]) },
    });
    await expect(userConversations(null, { userId: "u1" }, ctx)).rejects.toThrow(
      "pool exhausted",
    );
  });

  it("does not log an admin listing their own Conversations", async () => {
    const ctx = buildContext(ADMIN, {
      conversations: { findMany: vi.fn().mockResolvedValue([{ id: "t1" }]) },
    });
    await userConversations(null, { userId: "a1" }, ctx);
    expect(logActivity).not.toHaveBeenCalled();
  });

  for (const [name, user] of [
    ["an analyst", OTHER],
    ["a viewer", OWNER],
    ["a pending user", PENDING],
  ] as const) {
    it(`is FORBIDDEN for ${name}`, async () => {
      const findMany = vi.fn();
      const ctx = buildContext(user, { conversations: { findMany } });
      await expect(userConversations(null, { userId: "u1" }, ctx)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(findMany).not.toHaveBeenCalled();
      expect(logActivity).not.toHaveBeenCalled();
    });
  }

  it("is UNAUTHENTICATED without a session", async () => {
    await expect(
      userConversations(null, { userId: "u1" }, buildContext(null)),
    ).rejects.toThrow(/logged in/);
  });
});

describe("Mutation.recordConversationTurnUsage", () => {
  const usage = {
    model: "anthropic/claude-sonnet-5-5",
    inputTokens: 1200,
    outputTokens: 340,
    costUsd: 0.0087,
    latencyMs: 4200,
  };
  const answer = { role: "assistant", conversation: { userId: "u1" } };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records usage once on the owner's Answer, stamped with server time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T09:30:00.000Z"));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "m2" });
    const ctx = buildContext(OWNER, {
      conversationMessages: {
        findUnique: vi.fn().mockResolvedValue(answer),
        updateMany,
        findUniqueOrThrow,
      },
    });
    await expect(
      recordConversationTurnUsage(null, { messageId: "m2", usage }, ctx),
    ).resolves.toEqual({ id: "m2" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "m2", usageRecordedAt: null },
      data: {
        ...usage,
        usageRecordedAt: new Date("2026-10-01T09:30:00.000Z"),
      },
    });
  });

  it("is FORBIDDEN to re-record (e.g. lower) a turn's usage", async () => {
    const ctx = buildContext(OWNER, {
      conversationMessages: {
        findUnique: vi.fn().mockResolvedValue(answer),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    await expect(
      recordConversationTurnUsage(
        null,
        { messageId: "m2", usage: { ...usage, costUsd: 0 } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("is FORBIDDEN with an API key", async () => {
    const findUnique = vi.fn();
    const ctx = buildContext(OWNER, { conversationMessages: { findUnique } }, "api-key");
    await expect(
      recordConversationTurnUsage(null, { messageId: "m2", usage }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for another user and for an admin, and writes nothing", async () => {
    for (const user of [OTHER, ADMIN]) {
      const updateMany = vi.fn();
      const ctx = buildContext(user, {
        conversationMessages: {
          findUnique: vi.fn().mockResolvedValue(answer),
          updateMany,
        },
      });
      await expect(
        recordConversationTurnUsage(null, { messageId: "m2", usage }, ctx),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("rejects usage on a user turn", async () => {
    const ctx = buildContext(OWNER, {
      conversationMessages: {
        findUnique: vi.fn().mockResolvedValue({ ...answer, role: "user" }),
      },
    });
    await expect(
      recordConversationTurnUsage(null, { messageId: "m1", usage }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("is NOT_FOUND for an unknown message", async () => {
    const ctx = buildContext(OWNER, {
      conversationMessages: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      recordConversationTurnUsage(null, { messageId: "nope", usage }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it.each([
    ["a negative cost", { costUsd: -0.01 }],
    ["a non-finite cost", { costUsd: Number.POSITIVE_INFINITY }],
    ["fractional tokens", { inputTokens: 1.5 }],
    ["negative latency", { latencyMs: -1 }],
    ["an empty model", { model: "" }],
  ])("rejects %s before any lookup", async (_name, bad) => {
    const findUnique = vi.fn();
    const ctx = buildContext(OWNER, { conversationMessages: { findUnique } });
    await expect(
      recordConversationTurnUsage(
        null,
        { messageId: "m2", usage: { ...usage, ...bad } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for a pending user", async () => {
    await expect(
      recordConversationTurnUsage(
        null,
        { messageId: "m2", usage },
        buildContext(PENDING),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});

describe("Query.myAgentBudget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function budgetContext(user: User, sum: number | null) {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: sum } });
    return {
      aggregate,
      ctx: buildContext(user, { conversationMessages: { aggregate } }),
    };
  }

  it("sums the caller's cost since UTC midnight, and resets at the next one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T17:45:00.000Z"));
    const { ctx, aggregate } = budgetContext(OWNER, 0.42);
    await expect(myAgentBudget(null, {}, ctx)).resolves.toEqual({
      limitUsd: 2.5,
      spentTodayUsd: 0.42,
      resetsAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        conversation: { userId: "u1" },
        usageRecordedAt: { gte: new Date("2026-10-01T00:00:00.000Z") },
      },
      _sum: { costUsd: true },
    });
  });

  it("uses the UTC day, not the server's local day, just after midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00.001Z"));
    const { ctx, aggregate } = budgetContext(OWNER, null);
    const budget = await myAgentBudget(null, {}, ctx);
    expect(aggregate.mock.calls[0][0].where.usageRecordedAt).toEqual({
      gte: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(budget.resetsAt).toEqual(new Date("2026-10-03T00:00:00.000Z"));
  });

  it("reports zero spend when nothing has been recorded today", async () => {
    const { ctx } = budgetContext(OWNER, null);
    await expect(myAgentBudget(null, {}, ctx)).resolves.toMatchObject({
      spentTodayUsd: 0,
    });
  });

  it("is FORBIDDEN for a pending user", async () => {
    await expect(myAgentBudget(null, {}, buildContext(PENDING))).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("is UNAUTHENTICATED without a session", async () => {
    await expect(myAgentBudget(null, {}, buildContext(null))).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });
});

describe("Agent working memory", () => {
  it("reads only the caller's working memory", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(OWNER, { agentWorkingMemory: { findUnique } });
    await expect(myAgentWorkingMemory(null, {}, ctx)).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("upserts the caller's working memory, keyed by user", async () => {
    const upsert = vi.fn().mockResolvedValue({ userId: "u1" });
    const ctx = buildContext(OWNER, { agentWorkingMemory: { upsert } });
    await saveAgentWorkingMemory(
      null,
      { input: { workingMemory: "# User\n- Works on Sudan" } },
      ctx,
    );
    expect(upsert).toHaveBeenCalledWith({
      where: { userId: "u1" },
      create: { userId: "u1", workingMemory: "# User\n- Works on Sudan" },
      update: { workingMemory: "# User\n- Works on Sudan" },
    });
  });

  it("leaves omitted fields unchanged", async () => {
    const upsert = vi.fn().mockResolvedValue({ userId: "u1" });
    const ctx = buildContext(OWNER, { agentWorkingMemory: { upsert } });
    await saveAgentWorkingMemory(null, { input: { metadata: { v: 2 } } }, ctx);
    expect(upsert.mock.calls[0][0].update).toEqual({ metadata: { v: 2 } });
  });

  it("refuses a write with an API key", () => {
    const upsert = vi.fn();
    const ctx = buildContext(OWNER, { agentWorkingMemory: { upsert } }, "api-key");
    expect(() => saveAgentWorkingMemory(null, { input: {} }, ctx)).toThrow(/API key/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects an oversized working memory", async () => {
    const upsert = vi.fn();
    const ctx = buildContext(OWNER, { agentWorkingMemory: { upsert } });
    expect(() =>
      saveAgentWorkingMemory(
        null,
        { input: { workingMemory: "x".repeat(100_001) } },
        ctx,
      ),
    ).toThrow(/at most 100000 characters/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for a pending user and UNAUTHENTICATED without a session", async () => {
    expect(() => myAgentWorkingMemory(null, {}, buildContext(PENDING))).toThrow(
      /awaiting admin approval/,
    );
    expect(() =>
      saveAgentWorkingMemory(null, { input: {} }, buildContext(null)),
    ).toThrow(/logged in/);
  });
});

describe("Query.conversationMessagesByIds", () => {
  it("returns only messages in the caller's own Conversations", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(OWNER, { conversationMessages: { findMany } });
    await conversationMessagesByIds(null, { ids: ["m1", "m9"] }, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m9"] }, conversation: { userId: "u1" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("scopes a platform admin to their own messages too", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(ADMIN, { conversationMessages: { findMany } });
    await conversationMessagesByIds(null, { ids: ["m1"] }, ctx);
    expect(findMany.mock.calls[0][0].where.conversation).toEqual({ userId: "a1" });
  });

  it("rejects more than 200 ids, and skips the query for none", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(OWNER, { conversationMessages: { findMany } });
    await expect(
      conversationMessagesByIds(null, { ids: Array.from({ length: 201 }, (_, i) => `m${i}`) }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(conversationMessagesByIds(null, { ids: [] }, ctx)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("is FORBIDDEN for a pending user", async () => {
    await expect(
      conversationMessagesByIds(null, { ids: ["m1"] }, buildContext(PENDING)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});

describe("Conversation.messages", () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id }));

  it("returns the most recent 500 chronologically when first is omitted", async () => {
    const findMany = vi.fn().mockResolvedValue(rows("m3", "m2", "m1"));
    const ctx = buildContext(OWNER, { conversationMessages: { findMany } });
    const result = await messages({ id: "t1" }, {}, ctx);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { conversationId: "t1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 500,
    });
  });

  it("keeps the most recent `first` messages, in chronological order", async () => {
    const findMany = vi.fn().mockResolvedValue(rows("m9", "m8"));
    const ctx = buildContext(OWNER, { conversationMessages: { findMany } });
    const result = await messages({ id: "t1" }, { first: 2 }, ctx);
    expect(findMany.mock.calls[0][0].take).toBe(2);
    expect(result.map((m) => m.id)).toEqual(["m8", "m9"]);
  });

  it("pages back from `before` with an id tie-break on equal timestamps", async () => {
    const at = new Date("2026-10-01T08:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(OWNER, {
      conversationMessages: {
        findUnique: vi.fn().mockResolvedValue({ conversationId: "t1", createdAt: at }),
        findMany,
      },
    });
    await messages({ id: "t1" }, { first: 10, before: "m5" }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({
      conversationId: "t1",
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "m5" } }],
    });
  });

  it("rejects a `before` id from another Conversation", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(OWNER, {
      conversationMessages: {
        findUnique: vi.fn().mockResolvedValue({ conversationId: "other", createdAt: new Date() }),
        findMany,
      },
    });
    await expect(
      messages({ id: "t1" }, { before: "m5" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects first outside 1–500", async () => {
    const ctx = buildContext(OWNER);
    await expect(messages({ id: "t1" }, { first: 501 }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});

describe("Conversation.messageCount", () => {
  it("counts the Conversation's messages", async () => {
    const count = vi.fn().mockResolvedValue(4);
    const ctx = buildContext(OWNER, { conversationMessages: { count } });
    await expect(messageCount({ id: "t1" }, {}, ctx)).resolves.toBe(4);
    expect(count).toHaveBeenCalledWith({ where: { conversationId: "t1" } });
  });
});
