/**
 * DB-free tests for `activity-insights.ts`: the Agent usage query never
 * selects message content, routes normalise, the aggregates add up, and the
 * CSV is quoted and formula-safe.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AGENT_USAGE_SELECT,
  agentUsageStats,
  normaliseRoute,
  toNrcCsv,
} from "../../src/services/activity-insights.js";
import { activityLogResolvers } from "../../src/resolvers/activityLog.resolver.js";
import type { Context } from "../../src/context.js";

const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2026-10-31T00:00:00Z");

describe("agentUsageStats", () => {
  it("never selects message content", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await agentUsageStats({ conversationMessages: { findMany } } as never, FROM, TO);
    const { select } = findMany.mock.calls[0]![0];
    expect(select).toBe(AGENT_USAGE_SELECT);
    expect(Object.keys(select)).not.toContain("content");
    expect(JSON.stringify(select)).not.toContain("content");
  });

  it("aggregates turns, users, cost and routes", async () => {
    const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
    const findMany = vi.fn().mockResolvedValue([
      {
        role: "user",
        createdAt: at("02"),
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        currentView: { route: "/events/cmabcdefghijklmnopqrstu" },
        conversation: { userId: "a" },
      },
      {
        role: "assistant",
        createdAt: at("02"),
        costUsd: 0.5,
        inputTokens: 10,
        outputTokens: 20,
        currentView: null,
        conversation: { userId: "a" },
      },
      {
        role: "user",
        createdAt: at("03"),
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        currentView: { route: "/events/cmzzzzzzzzzzzzzzzzzzzzz" },
        conversation: { userId: "b" },
      },
      {
        role: "user",
        createdAt: at("03"),
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        currentView: null,
        conversation: { userId: "b" },
      },
    ]);
    const s = await agentUsageStats({ conversationMessages: { findMany } } as never, FROM, TO);
    expect(s).toMatchObject({
      turns: 3,
      answers: 1,
      distinctUsers: 2,
      costUsd: 0.5,
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(s.byRoute).toEqual([
      { route: "/events/:id", turns: 2, distinctUsers: 2 },
      { route: "(unknown)", turns: 1, distinctUsers: 1 },
    ]);
    expect(s.byDay.map((d) => d.date)).toEqual(["2026-10-02", "2026-10-03"]);
  });

  it("is admin-only", async () => {
    const ctx = { user: { id: "u", role: "member" }, prisma: {} } as unknown as Context;
    await expect(activityLogResolvers.Query.agentUsageStats(null, {}, ctx)).rejects.toThrow();
    await expect(activityLogResolvers.Query.nrcActivityExport(null, {}, ctx)).rejects.toThrow();
  });
});

describe("normaliseRoute", () => {
  it("collapses id segments and drops query strings", () => {
    expect(normaliseRoute({ route: "/crises/123?tab=x" })).toBe("/crises/:id");
    expect(normaliseRoute({ route: "/" })).toBe("/");
    expect(normaliseRoute("nope")).toBe("(unknown)");
  });
});

describe("toNrcCsv", () => {
  it("writes a header, quotes commas and neutralises formulas", () => {
    const csv = toNrcCsv([
      {
        month: "2026-10",
        organisation: "NRC, Norway",
        team: "=cmd()",
        role: "analyst",
        distinctUsers: 5,
        actions: 9,
        agentTurns: 2,
        agentCostUsd: 0.1,
      },
    ]);
    expect(csv).toBe(
      "month,organisation,team,role,distinct_users,actions,agent_turns,agent_cost_usd\n" +
        '2026-10,"NRC, Norway",\'=cmd(),analyst,5,9,2,0.1000\n',
    );
  });
});
