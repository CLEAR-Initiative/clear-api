/**
 * Integration tests for `conversation.resolver.ts` against the real, migrated
 * schema.
 *
 * The DB-free suite stubs Prisma, so it can't catch a wrong column, a broken
 * cursor, or a migration that never created the tables. These tests run the
 * add_agent_conversations / add_agent_working_memory migrations' tables for
 * real: messages upserted by caller-supplied id, the history window and its
 * timestamp tie-break, ordering by activity, the budget sum, the working
 * memory upsert, the cascade when a user is deleted, and the races between
 * the write path's ownership/finalization checks and its writes.
 *
 * Self-seeding: every row hangs off a fresh user, deleted (with everything it
 * owns) in afterAll, so this runs against an empty scratch database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  conversationResolvers,
  encodeConversationCursor,
} from "../../src/resolvers/conversation.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const {
  conversation,
  myConversations,
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
const { messages } = conversationResolvers.Conversation;

const RUN = `conversation-db-${Date.now()}`;
const USER_ID = `${RUN}-user`;
const RIVAL_ID = `${RUN}-rival`;
const T1 = `${RUN}-t1`;
const T2 = `${RUN}-t2`;

const ctx = {
  prisma,
  user: { id: USER_ID, role: "viewer" },
  session: null,
  authMethod: "session",
  viaAgent: true,
} as unknown as Context;

const rivalCtx = { ...ctx, user: { id: RIVAL_ID, role: "viewer" } } as unknown as Context;

const text = (t: string) => ({ format: 2, parts: [{ type: "text", text: t }] });

/**
 * `base` with a client whose transactions start only after `meanwhile` has
 * run: a concurrent write landing between the resolver's checks and its
 * write, made deterministic.
 */
function racing(meanwhile: () => Promise<unknown>, base: Context = ctx): Context {
  const client = new Proxy(prisma, {
    get(target, prop) {
      if (prop === "$transaction") {
        return async (...args: Parameters<typeof prisma.$transaction>) => {
          await meanwhile();
          return target.$transaction(...args);
        };
      }
      return Reflect.get(target, prop);
    },
  });
  return { ...base, prisma: client } as Context;
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describeIfDb("Conversations against the real schema", () => {
  beforeAll(async () => {
    for (const id of [USER_ID, RIVAL_ID]) {
      await prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, role: "viewer" },
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER_ID, RIVAL_ID] } } });
  });

  it("stores a Conversation and upserts its messages by id", async () => {
    await upsertConversation(null, { input: { id: T1, title: "Darfur" } }, ctx);
    const at = "2026-10-01T08:00:00.000Z";
    await upsertConversationMessages(
      null,
      {
        conversationId: T1,
        messages: [
          {
            id: `${RUN}-m1`,
            role: "user",
            type: "v2",
            content: text("Access in Darfur?"),
            currentView: { route: "/map", filters: { country: "Sudan" } },
            createdAt: at,
          },
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
    expect(rows[0]!.currentView).toEqual({ route: "/map", filters: { country: "Sudan" } });
    // An update without createdAt keeps the original ordering key.
    expect(rows[1]!.createdAt.toISOString()).toBe("2026-10-01T08:00:05.000Z");

    const byId = await conversationMessagesByIds(
      null,
      { ids: [`${RUN}-m2`, `${RUN}-m1`, "not-a-message"] },
      ctx,
    );
    expect(ids(byId)).toEqual([`${RUN}-m1`, `${RUN}-m2`]);
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
    const cursor = encodeConversationCursor(page1[0]!);
    // Continuing the cursor's Thread between page loads must not make the
    // next page repeat or skip anything.
    await upsertConversationMessages(
      null,
      { conversationId: T1, messages: [{ id: `${RUN}-m4`, role: "user", content: text("And?") }] },
      ctx,
    );
    const page2 = await myConversations(null, { first: 1, after: cursor }, ctx);
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

    // Charged once: neither a lower re-record nor a rewrite of the Answer.
    await expect(
      recordConversationTurnUsage(
        null,
        {
          messageId: `${RUN}-m2`,
          usage: { model: "test/model", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: T1, messages: [{ id: `${RUN}-m2`, role: "assistant", content: text("Forged") }] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect((await myAgentBudget(null, {}, ctx)).spentTodayUsd).toBeCloseTo(after.spentTodayUsd);
  });

  it("never writes a message id that lives in another Conversation", async () => {
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: T2, messages: [{ id: `${RUN}-m1`, role: "user", content: text("Hijack") }] },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const original = await prisma.conversationMessages.findUniqueOrThrow({ where: { id: `${RUN}-m1` } });
    expect(original.conversationId).toBe(T1);
    expect(original.content).toEqual(text("Access in Darfur?"));
  });

  it("lets exactly one of two owners claim the same new message id at once", async () => {
    const mine = `${RUN}-race-mine`;
    const theirs = `${RUN}-race-theirs`;
    await upsertConversation(null, { input: { id: mine } }, ctx);
    await upsertConversation(null, { input: { id: theirs } }, rivalCtx);

    // Several rounds, so some overlap past the ownership check for real.
    for (let i = 0; i < 10; i++) {
      const id = `${RUN}-race-m${i}`;
      const results = await Promise.allSettled([
        upsertConversationMessages(
          null,
          { conversationId: mine, messages: [{ id, role: "user", content: text("mine") }] },
          ctx,
        ),
        upsertConversationMessages(
          null,
          { conversationId: theirs, messages: [{ id, role: "user", content: text("theirs") }] },
          rivalCtx,
        ),
      ]);
      const won = results.findIndex((r) => r.status === "fulfilled");
      const lost = results.find((r) => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((lost as PromiseRejectedResult).reason).toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      // The loser neither moved nor rewrote the winner's message.
      const row = await prisma.conversationMessages.findUniqueOrThrow({ where: { id } });
      expect(row.conversationId).toBe(won === 0 ? mine : theirs);
      expect(row.content).toEqual(text(won === 0 ? "mine" : "theirs"));
    }
  });

  it("accepts the same new message written twice at once into one Conversation", async () => {
    // An adapter retry racing its own first attempt must stay idempotent.
    for (let i = 0; i < 10; i++) {
      const id = `${RUN}-retry-m${i}`;
      const write = () =>
        upsertConversationMessages(
          null,
          { conversationId: `${RUN}-race-mine`, messages: [{ id, role: "assistant", content: text("same") }] },
          ctx,
        );
      const results = await Promise.allSettled([write(), write()]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await prisma.conversationMessages.count({ where: { id } })).toBe(1);
    }
  });

  it("never updates another owner's message claimed after the ownership check", async () => {
    const id = `${RUN}-late-claim`;
    const claim = () =>
      prisma.conversationMessages.create({
        data: { id, conversationId: `${RUN}-race-theirs`, role: "user", content: text("theirs") },
      });
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: `${RUN}-race-mine`, messages: [{ id, role: "user", content: text("mine") }] },
        racing(claim),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const row = await prisma.conversationMessages.findUniqueOrThrow({ where: { id } });
    expect(row.conversationId).toBe(`${RUN}-race-theirs`);
    expect(row.content).toEqual(text("theirs"));
  });

  it("never rewrites an Answer charged after the finalization check", async () => {
    const id = `${RUN}-late-charge`;
    await upsertConversationMessages(
      null,
      { conversationId: T1, messages: [{ id, role: "assistant", content: text("Answer") }] },
      ctx,
    );
    const charge = () =>
      recordConversationTurnUsage(
        null,
        {
          messageId: id,
          usage: { model: "test/model", inputTokens: 10, outputTokens: 5, costUsd: 0.1, latencyMs: 100 },
        },
        ctx,
      );
    await expect(
      upsertConversationMessages(
        null,
        { conversationId: T1, messages: [{ id, role: "assistant", content: text("Rewritten") }] },
        racing(charge),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const row = await prisma.conversationMessages.findUniqueOrThrow({ where: { id } });
    expect(row.content).toEqual(text("Answer"));
    expect(row.costUsd).toBeCloseTo(0.1);
  });

  it("caps history at 500 messages when first is omitted", async () => {
    const big = `${RUN}-big`;
    await upsertConversation(null, { input: { id: big } }, ctx);
    const base = Date.parse("2026-10-01T10:00:00.000Z");
    const all = Array.from({ length: 501 }, (_, i) => ({
      id: `${RUN}-big-${String(i).padStart(3, "0")}`,
      role: "user",
      content: text(String(i)),
      createdAt: new Date(base + i * 1000).toISOString(),
    }));
    for (let i = 0; i < all.length; i += 200) {
      await upsertConversationMessages(
        null,
        { conversationId: big, messages: all.slice(i, i + 200) },
        ctx,
      );
    }
    const window = await messages({ id: big }, {}, ctx);
    expect(window).toHaveLength(500);
    // The oldest message is the one dropped; order stays chronological.
    expect(window[0]!.id).toBe(all[1]!.id);
    expect(window.at(-1)!.id).toBe(all[500]!.id);
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
