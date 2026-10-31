/**
 * Agent usage metrics against the real schema (ADR-0013): turns are picked
 * by their usage record, tool calls and the asking page are read from the
 * stored message parts, unrecorded Answers are counted apart, and the recent
 * questions come out newest first without the user. Self-seeding; run with
 * `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { computeAgentMetrics, fetchRecentQuestions } from "../../src/services/agent-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `agent-metrics-db-${Date.now()}`;
const USER_A = `${RUN}-a`;
const USER_B = `${RUN}-b`;
const CONV_A = `${RUN}-conv-a`;
const CONV_B = `${RUN}-conv-b`;
const RANGE = { from: "2026-10-05T00:00:00.000Z", to: "2026-10-18T23:59:59.999Z" };
let n = 0;

const at = (iso: string) => new Date(iso);

/** A user turn as clear-mvp's memory adapter stores it (format 2). */
async function question(conversationId: string, iso: string, text: string, route: string | null) {
  await prisma.conversationMessages.create({
    data: {
      id: `${RUN}-m${n++}`,
      conversationId,
      role: "user",
      type: "v2",
      content: { format: 2, parts: [{ type: "text", text }] },
      currentView: route ? { route, filters: {} } : undefined,
      createdAt: at(iso),
    },
  });
}

/** An Answer with the tools it called and, unless `unrecorded`, its usage. */
async function answer(
  conversationId: string,
  iso: string,
  tools: string[],
  usage: { costUsd: number; latencyMs: number; inputTokens?: number; model?: string } | null,
) {
  await prisma.conversationMessages.create({
    data: {
      id: `${RUN}-m${n++}`,
      conversationId,
      role: "assistant",
      type: "v2",
      content: {
        format: 2,
        parts: [
          ...tools.map((toolName) => ({
            type: "tool-invocation",
            toolInvocation: { toolName, toolCallId: `${RUN}-t${n++}`, state: "result", args: {}, result: {} },
          })),
          { type: "text", text: "Here is what I found." },
        ],
      },
      createdAt: at(iso),
      ...(usage
        ? {
            model: usage.model ?? "anthropic/claude-sonnet-5-5",
            inputTokens: usage.inputTokens ?? 1000,
            outputTokens: 100,
            costUsd: usage.costUsd,
            latencyMs: usage.latencyMs,
            // Recorded a minute after the Answer was written.
            usageRecordedAt: new Date(at(iso).getTime() + 60_000),
          }
        : {}),
    },
  });
}

describeIfDb("agent usage metrics against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: USER_A, name: "A", email: `${USER_A}@example.org`, role: "analyst" },
        { id: USER_B, name: "B", email: `${USER_B}@example.org`, role: "analyst" },
      ],
    });
    await prisma.conversations.create({ data: { id: CONV_A, userId: USER_A, title: "A", createdAt: at("2026-10-01T00:00:00Z") } });
    await prisma.conversations.create({ data: { id: CONV_B, userId: USER_B, title: "B", createdAt: at("2026-10-14T11:59:00Z") } });

    // Conversation A: two turns in W41, one of them from the map.
    await question(CONV_A, "2026-10-06T09:00:00Z", "What's new in the last 24 hours?", "/dashboard");
    await answer(CONV_A, "2026-10-06T09:00:20Z", ["clear_list_events", "clear_count"], { costUsd: 0.1, latencyMs: 20_000 });
    await question(CONV_A, "2026-10-06T09:05:00Z", "Show me Khartoum on the map", "/dashboard");
    await answer(CONV_A, "2026-10-06T09:05:10Z", ["navigate"], { costUsd: 0.3, latencyMs: 10_000 });
    // An Answer that failed before usage was recorded.
    await question(CONV_A, "2026-10-06T09:10:00Z", "And South Kordofan?", "/map");
    await answer(CONV_A, "2026-10-06T09:10:05Z", [], null);
    // Conversation B: a new Conversation in W42, asked from an Event page, no view on the second.
    await question(CONV_B, "2026-10-14T12:00:00Z", "have there been battles at Abu Zabad before?", "/event/cmuou1ilf00kj1hp13hpg25vq");
    await answer(CONV_B, "2026-10-14T12:00:40Z", ["clear_find_location", "clear_get_event", "nrc_find"], { costUsd: 0.5, latencyMs: 40_000, inputTokens: 148_836 });
    await question(CONV_B, "2026-10-15T12:00:00Z", "Turn the above into a graph chart", null);
    await answer(CONV_B, "2026-10-15T12:00:30Z", [], { costUsd: 0.2, latencyMs: 30_000 });
    // Out of range: recorded after `to`.
    await question(CONV_B, "2026-10-20T12:00:00Z", "test", "/map");
    await answer(CONV_B, "2026-10-20T12:00:02Z", [], { costUsd: 0.01, latencyMs: 2_000 });
  });

  afterAll(async () => {
    await prisma.conversationMessages.deleteMany({ where: { conversationId: { in: [CONV_A, CONV_B] } } });
    await prisma.conversations.deleteMany({ where: { id: { in: [CONV_A, CONV_B] } } });
    await prisma.activityLogs.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  });

  it("measures the turns whose usage was recorded in range", async () => {
    const m = await computeAgentMetrics(prisma, RANGE, { budgetLimitUsd: 0.4 });
    expect(m).toMatchObject({
      turns: 4,
      turnsUnrecorded: 1,
      conversations: 2,
      newConversations: 1,
      users: 2,
      turnsWithoutTools: 1,
      turnsWithManyToolCalls: 0,
      budgetLimitUsd: 0.4,
      // A spent 0.4 on 10-06 and B 0.5 on 10-14: both days reached 0.4.
      budgetHits: 2,
    });
    expect(m.totalCostUsd).toBeCloseTo(1.1);
    expect(m.latencyMedianMs).toBe(25_000);
    expect(m.totalInputTokens).toBe(3 * 1000 + 148_836);
    expect(m.toolCallsPerTurn).toBeCloseTo(6 / 4);
    expect(m.byModel).toEqual([
      { model: "anthropic/claude-sonnet-5-5", turns: 4, costUsd: expect.closeTo(1.1, 5), inputTokens: 151_836, outputTokens: 400 },
    ]);
    expect(m.byTool.map((t) => [t.tool, t.calls, t.turns])).toEqual([
      ["clear_count", 1, 1],
      ["clear_find_location", 1, 1],
      ["clear_get_event", 1, 1],
      ["clear_list_events", 1, 1],
      ["navigate", 1, 1],
      ["nrc_find", 1, 1],
    ]);
    expect(m.byPage).toEqual([
      { page: "/dashboard", turns: 2 },
      { page: "/event", turns: 1 },
      { page: "unknown", turns: 1 },
    ]);
    expect(m.weekly.map((w) => [w.isoWeek, w.turns, w.conversations, w.models])).toEqual([
      ["2026-W41", 2, 1, ["anthropic/claude-sonnet-5-5"]],
      ["2026-W42", 2, 1, ["anthropic/claude-sonnet-5-5"]],
    ]);
  });

  it("counts a budget hit from the whole day when the range starts after some of the day's spend", async () => {
    // From 09:03 on 10-06: A's 0.1 turn (recorded 09:01) is before `from`, the 0.3 one (09:06) inside.
    const m = await computeAgentMetrics(prisma, { from: "2026-10-06T09:03:00.000Z", to: RANGE.to }, { budgetLimitUsd: 0.4 });
    expect(m.turns).toBe(3);
    expect(m.totalCostUsd).toBeCloseTo(1.0);
    // A's day reached 0.4 in full, B's 10-14 reached 0.5: two hits, though only 0.3 of A's is in range.
    expect(m.budgetHits).toBe(2);
  });

  it("lists the recent questions newest first, cut, with the page and without the user", async () => {
    const rows = await fetchRecentQuestions(prisma, { from: at(RANGE.from), to: at(RANGE.to) }, 3);
    expect(rows.map((r) => [r.question, r.route, r.conversationId])).toEqual([
      ["Turn the above into a graph chart", null, CONV_B],
      ["have there been battles at Abu Zabad before?", "/event/cmuou1ilf00kj1hp13hpg25vq", CONV_B],
      ["And South Kordofan?", "/map", CONV_A],
    ]);
    expect(rows[0]).not.toHaveProperty("userId");
    expect((await fetchRecentQuestions(prisma, { from: at(RANGE.from), to: at(RANGE.to) }, 500)).length).toBeLessThanOrEqual(50);
  });
});
