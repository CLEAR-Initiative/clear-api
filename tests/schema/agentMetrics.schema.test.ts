/**
 * Schema contract for `agentMetrics` (ADR-0013): the document clear-mvp's
 * `metrics.agent` will send, executed through a real ApolloServer, so the
 * input shape, every selected field and the error codes are pinned at the
 * seam, and `recentQuestions` is read and audited only when selected.
 *
 * DB-FREE: `context.prisma` is mocked. `$queryRaw` answers the turns query,
 * the unrecorded count and the questions query by what each selects.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const AGENT_METRICS = `
  query AgentMetrics($input: AgentMetricsInput, $withQuestions: Boolean = false) {
    agentMetrics(input: $input) {
      from
      to
      turns
      turnsUnrecorded
      conversations
      newConversations
      users
      totalCostUsd
      costPerTurnUsd
      costPerTurnP95Usd
      costPerConversationUsd
      latencyMedianMs
      latencyP95Ms
      totalInputTokens
      totalOutputTokens
      inputTokensPerTurn
      outputTokensPerTurn
      toolCallsPerTurn
      turnsWithoutTools
      turnsWithManyToolCalls
      budgetLimitUsd
      budgetHits
      byModel { model turns costUsd inputTokens outputTokens }
      byTool { tool calls turns }
      byPage { page turns }
      weekly { isoWeek weekStart isPartial turns conversations users costUsd costPerTurnUsd latencyMedianMs inputTokensPerTurn toolCallsPerTurn models }
      recentQuestions(first: 5) @include(if: $withQuestions) { askedAt question page }
    }
  }
`;

const TURNS = [
  {
    conversationId: "c1",
    userId: "u1",
    conversationCreatedAt: new Date("2026-10-06T08:00:00Z"),
    model: "anthropic/claude-sonnet-5-5",
    inputTokens: 55000,
    outputTokens: 3000,
    costUsd: 0.14,
    latencyMs: 25000,
    usageRecordedAt: new Date("2026-10-06T09:00:00Z"),
    tools: ["clear_list_events", "clear_count"],
    route: "/dashboard",
  },
];
const QUESTIONS = [
  { conversationId: "c1", askedAt: new Date("2026-10-06T08:59:00Z"), question: "What's new in the last 24 hours?", route: "/dashboard" },
];

function sqlOf(call: unknown[]): string {
  const [strings] = call as [TemplateStringsArray, ...unknown[]];
  return strings.join("?");
}

async function run(user: { id: string; role: string } | null, variables: Record<string, unknown>) {
  const $queryRaw = vi.fn(async (...call: unknown[]) => {
    const sql = sqlOf(call);
    if (sql.includes('"usage_recorded_at" IS NULL')) return [{ count: 2 }];
    if (sql.includes("'user'") && sql.includes("LIMIT") && !sql.includes("LATERAL")) return QUESTIONS;
    return TURNS;
  });
  const activityLogs = { create: vi.fn(async () => ({})) };
  const prisma = { $queryRaw, activityLogs };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query: AGENT_METRICS, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

describe("agentMetrics schema contract", () => {
  it("executes clear-mvp's document for an admin, without touching question text", async () => {
    const { result, prisma } = await run(
      { id: "a", role: "admin" },
      { input: { from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z" } },
    );
    expect(result.errors).toBeUndefined();
    const m = result.data?.agentMetrics as Record<string, unknown>;
    expect(m).toMatchObject({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-11T23:59:59.999Z",
      turns: 1,
      turnsUnrecorded: 2,
      conversations: 1,
      newConversations: 1,
      users: 1,
      totalCostUsd: 0.14,
      costPerTurnUsd: 0.14,
      latencyMedianMs: 25000,
      totalInputTokens: 55000,
      toolCallsPerTurn: 2,
      turnsWithoutTools: 0,
      turnsWithManyToolCalls: 0,
      budgetHits: 0,
      byModel: [{ model: "anthropic/claude-sonnet-5-5", turns: 1, costUsd: 0.14, inputTokens: 55000, outputTokens: 3000 }],
      byTool: [
        { tool: "clear_count", calls: 1, turns: 1 },
        { tool: "clear_list_events", calls: 1, turns: 1 },
      ],
      byPage: [{ page: "/dashboard", turns: 1 }],
    });
    expect(typeof m.budgetLimitUsd).toBe("number");
    expect(m.weekly).toEqual([
      expect.objectContaining({ isoWeek: "2026-W41", weekStart: "2026-10-05T00:00:00.000Z", isPartial: false, turns: 1, models: ["anthropic/claude-sonnet-5-5"] }),
    ]);
    expect(m.recentQuestions).toBeUndefined();
    // Turns and the unrecorded count: never the questions.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.activityLogs.create).not.toHaveBeenCalled();
  });

  it("reads and audits recent questions only when selected, without the user", async () => {
    const { result, prisma } = await run(
      { id: "a", role: "admin" },
      { input: { from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z" }, withQuestions: true },
    );
    expect(result.errors).toBeUndefined();
    const m = result.data?.agentMetrics as { recentQuestions: unknown[] };
    expect(m.recentQuestions).toEqual([
      { askedAt: "2026-10-06T08:59:00.000Z", question: "What's new in the last 24 hours?", page: "/dashboard" },
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.activityLogs.create).toHaveBeenCalledTimes(1);
    const [{ data }] = prisma.activityLogs.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      userId: "a",
      action: "conversation.admin_read",
      resourceType: "conversation",
      metadata: expect.objectContaining({ listing: true, via: "agentMetrics.recentQuestions", conversationIds: ["c1"] }),
    });
  });

  it("is FORBIDDEN to a non-admin and BAD_USER_INPUT for an inverted range, without querying", async () => {
    const forbidden = await run({ id: "u", role: "analyst" }, {});
    expect(forbidden.result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(forbidden.prisma.$queryRaw).not.toHaveBeenCalled();

    const inverted = await run({ id: "a", role: "admin" }, { input: { from: "2026-10-11T00:00:00Z", to: "2026-10-05T00:00:00Z" } });
    expect(inverted.result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(inverted.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
