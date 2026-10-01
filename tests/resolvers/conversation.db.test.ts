/**
 * Integration tests for `conversation.resolver.ts` against the real, migrated
 * schema.
 *
 * The DB-free suite stubs Prisma, so it can't catch a wrong column, a broken
 * cursor, or a migration that never created the tables. These tests run the
 * add_agent_conversations / add_agent_working_memory migrations' tables for
 * real: messages upserted by caller-supplied id, the history window and its
 * timestamp tie-break, ordering by activity, the budget sum, the working
 * memory upsert, and the cascade when a user is deleted.
 *
 * Self-seeding: every row hangs off a fresh user, deleted (with everything it
 * owns) in afterAll, so this runs against an empty scratch database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { conversationResolvers } from "../../src/resolvers/conversation.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { conversation, myConversations, myAgentBudget, myAgentWorkingMemory } =
  conversationResolvers.Query;
const {
  upsertConversation,
  upsertConversationMessages,
  recordConversationTurnUsage,
  saveAgentWorkingMemory,
} = conversationResolvers.Mutation;
const { messages } = conversationResolvers.Conversation;

const RUN = `conversation-db-${Date.now()}`;
const USER_ID = `${RUN}-user`;
const T1 = `${RUN}-t1`;
const T2 = `${RUN}-t2`;

const ctx = {
  prisma,
  user: { id: USER_ID, role: "viewer" },
  session: null,
  authMethod: "session",
} as unknown as Context;

const text = (t: string) => ({ format: 2, parts: [{ type: "text", text: t }] });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describeIfDb("Conversations against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: USER_ID, name: RUN, email: `${RUN}@example.test`, role: "viewer" },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER_ID } });
  });

  it("stores a Conversation and upserts its messages by id", async () => {
    await upsertConversation(null, { input: { id: T1, title: "Darfur" } }, ctx);
    const at = "2026-10-01T08:00:00.000Z";
    await upsertConversationMessages(
      null,
      {
        conversationId: T1,
        messages: [
          { id: `${RUN}-m1`, role: "user", type: "v2", content: text("Access in Darfur?"), createdAt: at },
          { id: `${RUN}-m2`, role: "assistant", type: "v2", content: text("Draft"), createdAt: "2026-10-01T08:00:05.000Z" },
        ],
      },
      ctx,
    );
    // Same id again replaces the Answer instead of adding a row.
    await upsertConversationMessages(
      null,
      {
        conversationId: T1,
        messages: [{ id: `${RUN}-m2`, role: "assistant", type: "v2", content: text("Final") }],
      },
      ctx,
    );

    const stored = await conversation(null, { id: T1 }, ctx);
    expect(stored?.title).toBe("Darfur");
    const rows = await messages({ id: T1 }, {}, ctx);
    expect(ids(rows)).toEqual([`${RUN}-m1`, `${RUN}-m2`]);
    expect(rows[1]!.content).toEqual(text("Final"));
    // An update without createdAt keeps the original ordering key.
    expect(rows[1]!.createdAt.toISOString()).toBe("2026-10-01T08:00:05.000Z");
  });

  it("windows history newest-last and pages back across equal timestamps", async () => {
    const same = "2026-10-01T09:00:00.000Z";
    await upsertConversationMessages(
      null,
      {
        conversationId: T1,
        messages: ["a", "b", "c"].map((s) => ({
          id: `${RUN}-tie-${s}`,
          role: "user",
          content: text(s),
          createdAt: same,
        })),
      },
      ctx,
    );
    const latest = await messages({ id: T1 }, { first: 2 }, ctx);
    expect(ids(latest)).toEqual([`${RUN}-tie-b`, `${RUN}-tie-c`]);
    const older = await messages({ id: T1 }, { first: 2, before: `${RUN}-tie-b` }, ctx);
    expect(ids(older)).toEqual([`${RUN}-m2`, `${RUN}-tie-a`]);
  });

  it("lists Conversations most recently active first, with a working cursor", async () => {
    await upsertConversation(null, { input: { id: T2 } }, ctx);
    // Writing to T1 makes it the most recently active again.
    await upsertConversationMessages(
      null,
      { conversationId: T1, messages: [{ id: `${RUN}-m3`, role: "user", content: text("More?") }] },
      ctx,
    );
    const page1 = await myConversations(null, { first: 1 }, ctx);
    expect(ids(page1)).toEqual([T1]);
    const page2 = await myConversations(null, { first: 1, after: T1 }, ctx);
    expect(ids(page2)).toEqual([T2]);
  });

  it("counts recorded turn cost toward today's budget", async () => {
    const before = await myAgentBudget(null, {}, ctx);
    await recordConversationTurnUsage(
      null,
      {
        messageId: `${RUN}-m2`,
        usage: { model: "test/model", inputTokens: 100, outputTokens: 20, costUsd: 0.25, latencyMs: 900 },
      },
      ctx,
    );
    const after = await myAgentBudget(null, {}, ctx);
    expect(after.spentTodayUsd - before.spentTodayUsd).toBeCloseTo(0.25);
    expect(after.resetsAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("upserts working memory, one row per user", async () => {
    expect(await myAgentWorkingMemory(null, {}, ctx)).toBeNull();
    await saveAgentWorkingMemory(null, { input: { workingMemory: "v1", metadata: { a: 1 } } }, ctx);
    await saveAgentWorkingMemory(null, { input: { workingMemory: "v2" } }, ctx);
    const memory = await myAgentWorkingMemory(null, {}, ctx);
    expect(memory).toMatchObject({ userId: USER_ID, workingMemory: "v2", metadata: { a: 1 } });
    expect(await prisma.agentWorkingMemory.count({ where: { userId: USER_ID } })).toBe(1);
  });

  it("deletes a user's Conversations and working memory with the user", async () => {
    const other = `${RUN}-gone`;
    await prisma.user.create({
      data: { id: other, name: other, email: `${other}@example.test`, role: "viewer" },
    });
    const otherCtx = { ...ctx, user: { id: other, role: "viewer" } } as unknown as Context;
    await upsertConversation(null, { input: { id: `${other}-t` } }, otherCtx);
    await upsertConversationMessages(
      null,
      { conversationId: `${other}-t`, messages: [{ id: `${other}-m`, role: "user", content: text("x") }] },
      otherCtx,
    );
    await saveAgentWorkingMemory(null, { input: { workingMemory: "x" } }, otherCtx);

    await prisma.user.delete({ where: { id: other } });

    expect(await prisma.conversations.count({ where: { userId: other } })).toBe(0);
    expect(await prisma.conversationMessages.count({ where: { id: `${other}-m` } })).toBe(0);
    expect(await prisma.agentWorkingMemory.count({ where: { userId: other } })).toBe(0);
  });
});
