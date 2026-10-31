/**
 * Agent usage metrics (ADR-0013), DB-free: the summary over a handful of
 * turns, the weekly zero-fill, the page normalisation, budget hits and the
 * percentiles.
 */
import { describe, expect, it } from "vitest";
import {
  MANY_TOOL_CALLS,
  median,
  p95,
  pageOf,
  summarise,
  type AgentTurnRow,
} from "../../src/services/agent-metrics.js";

const RANGE = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-18T23:59:59.999Z") };

function turn(over: Partial<AgentTurnRow> & { at: string }): AgentTurnRow {
  return {
    conversationId: "c1",
    userId: "u1",
    conversationCreatedAt: new Date("2026-10-01T00:00:00Z"),
    model: "anthropic/claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 0.1,
    latencyMs: 1000,
    usageRecordedAt: new Date(over.at),
    tools: [],
    route: "/dashboard",
    ...over,
  };
}

describe("pageOf", () => {
  it("keeps the first segment and drops ids, queries and hashes", () => {
    expect(pageOf("/event/cmv5i4o7r001z1iqq9x317gsk")).toBe("/event");
    expect(pageOf("/map?country=SDN#x")).toBe("/map");
    expect(pageOf("/")).toBe("/");
    expect(pageOf("")).toBe("unknown");
    expect(pageOf(null)).toBe("unknown");
  });
});

describe("median and p95", () => {
  it("are null with no values and nearest-rank otherwise", () => {
    expect(median([])).toBeNull();
    expect(p95([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(p95([1])).toBe(1);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});

describe("summarise", () => {
  it("is all zeros and nulls, with zero-filled weeks, when nothing was asked", () => {
    const m = summarise([], RANGE, { budgetLimitUsd: 2 });
    expect(m).toMatchObject({
      turns: 0,
      turnsUnrecorded: 0,
      conversations: 0,
      users: 0,
      totalCostUsd: 0,
      costPerTurnUsd: null,
      latencyMedianMs: null,
      budgetLimitUsd: 2,
      budgetHits: 0,
      byModel: [],
      byTool: [],
      byPage: [],
    });
    expect(m.weekly.map((w) => [w.isoWeek, w.turns, w.isPartial])).toEqual([
      ["2026-W41", 0, false],
      ["2026-W42", 0, false],
    ]);
  });

  it("sums, averages and groups the turns in range", () => {
    const rows: AgentTurnRow[] = [
      // W41: two turns in one Conversation created before the range.
      turn({ at: "2026-10-06T09:00:00Z", costUsd: 0.1, latencyMs: 1000, tools: ["clear_list_events", "clear_count"] }),
      turn({ at: "2026-10-06T09:05:00Z", costUsd: 0.3, latencyMs: 3000, tools: ["navigate"], route: "/map" }),
      // W42: a new Conversation by another user, many tool calls, no model recorded.
      turn({
        at: "2026-10-14T12:00:00Z",
        conversationId: "c2",
        userId: "u2",
        conversationCreatedAt: new Date("2026-10-14T11:59:00Z"),
        model: null,
        costUsd: 0.5,
        latencyMs: 5000,
        inputTokens: 5000,
        tools: Array.from({ length: MANY_TOOL_CALLS + 1 }, (_, i) => (i % 2 ? "clear_count" : "clear_find_location")),
        route: "/event/abc",
      }),
      // W42: no tools, no latency recorded, no view sent.
      turn({ at: "2026-10-15T12:00:00Z", conversationId: "c2", userId: "u2", costUsd: 0.2, latencyMs: null, route: null }),
    ];
    const m = summarise(rows, RANGE, { budgetLimitUsd: 0.6, turnsUnrecorded: 1 });

    expect(m).toMatchObject({
      turns: 4,
      turnsUnrecorded: 1,
      conversations: 2,
      newConversations: 1,
      users: 2,
      totalInputTokens: 8000,
      totalOutputTokens: 400,
      inputTokensPerTurn: 2000,
      outputTokensPerTurn: 100,
      turnsWithoutTools: 1,
      turnsWithManyToolCalls: 1,
      budgetLimitUsd: 0.6,
    });
    expect(m.totalCostUsd).toBeCloseTo(1.1);
    expect(m.costPerTurnUsd).toBeCloseTo(0.275);
    expect(m.costPerTurnP95Usd).toBeCloseTo(0.5);
    expect(m.costPerConversationUsd).toBeCloseTo(0.55);
    // Latency is over the three turns that recorded one.
    expect(m.latencyMedianMs).toBe(3000);
    expect(m.latencyP95Ms).toBe(5000);
    expect(m.toolCallsPerTurn).toBeCloseTo((2 + 1 + 6 + 0) / 4);
    // u1 spent 0.4 on 10-06 (under 0.6); u2 spent 0.5 on 10-14 and 0.2 on 10-15: no day reached it.
    expect(m.budgetHits).toBe(0);
    expect(summarise(rows, RANGE, { budgetLimitUsd: 0.4 }).budgetHits).toBe(2);

    expect(m.byModel).toEqual([
      { model: "anthropic/claude-sonnet-5-5", turns: 3, costUsd: expect.closeTo(0.6, 5), inputTokens: 3000, outputTokens: 300 },
      { model: "unknown", turns: 1, costUsd: 0.5, inputTokens: 5000, outputTokens: 100 },
    ]);
    expect(m.byTool).toEqual([
      { tool: "clear_count", calls: 4, turns: 2 },
      { tool: "clear_find_location", calls: 3, turns: 1 },
      { tool: "clear_list_events", calls: 1, turns: 1 },
      { tool: "navigate", calls: 1, turns: 1 },
    ]);
    expect(m.byPage).toEqual([
      { page: "/dashboard", turns: 1 },
      { page: "/event", turns: 1 },
      { page: "/map", turns: 1 },
      { page: "unknown", turns: 1 },
    ]);

    expect(m.weekly).toHaveLength(2);
    expect(m.weekly[0]).toMatchObject({
      isoWeek: "2026-W41",
      turns: 2,
      conversations: 1,
      users: 1,
      costPerTurnUsd: expect.closeTo(0.2, 5),
      latencyMedianMs: 2000,
      inputTokensPerTurn: 1000,
      toolCallsPerTurn: 1.5,
      models: ["anthropic/claude-sonnet-5-5"],
    });
    expect(m.weekly[1]).toMatchObject({
      isoWeek: "2026-W42",
      turns: 2,
      users: 1,
      latencyMedianMs: 5000,
      models: ["anthropic/claude-sonnet-5-5", "unknown"],
    });
    expect(m.weekly[1]!.costUsd).toBeCloseTo(0.7);
  });

  it("marks the weeks the range only partly covers", () => {
    const m = summarise([], { from: new Date("2026-10-07T00:00:00Z"), to: new Date("2026-10-14T12:00:00Z") }, { budgetLimitUsd: 2 });
    expect(m.weekly.map((w) => [w.isoWeek, w.isPartial])).toEqual([
      ["2026-W41", true],
      ["2026-W42", true],
    ]);
  });
});
