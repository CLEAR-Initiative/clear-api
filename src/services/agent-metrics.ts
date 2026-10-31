/**
 * CLEAR Agent usage metrics (ADR-0013): what the Agent costs, how fast it
 * answers, how much it is used, and what it is used for, over a range, for
 * the admin /metrics page in clear-mvp.
 *
 * The unit is a **turn**: one Answer the Agent gave, with the usage clear-mvp
 * recorded for it through `recordConversationTurnUsage` (model, tokens, cost,
 * latency). A turn is in range when its usage was recorded in the range
 * (`usageRecordedAt`, server time), the same instant the daily budget sums
 * by. Answers whose usage was never recorded (the turn failed, or the record
 * was lost) are counted apart as `turnsUnrecorded`, by `createdAt`.
 *
 * Tool calls are read from the Answer's stored parts, so no new write path
 * is needed. The page a question was asked from is the `route` of the user
 * turn that preceded the Answer, cut to its first path segment so ids never
 * reach the metric. The API returns counts and sums; clear-mvp formats them.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { isoWeekLabel, resolveRange, startOfIsoWeek, utcDay } from "./detection-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** A turn with more tool calls than this is "many": the tool-thrash signal. */
export const MANY_TOOL_CALLS = 5;
/** Recent questions: default and most a caller may ask for. */
export const DEFAULT_RECENT_QUESTIONS = 20;
export const MAX_RECENT_QUESTIONS = 50;
/** A question is shown cut to this many characters. */
export const QUESTION_CHARS = 160;
/** Label for a turn whose model or page is unknown. */
export const UNKNOWN = "unknown";

export interface AgentMetricsInput {
  from?: Date | string | null;
  to?: Date | string | null;
}

/** One turn in range, as the metric needs it. */
export interface AgentTurnRow {
  conversationId: string;
  userId: string;
  /** When the Conversation was created; a new Conversation is one created in range. */
  conversationCreatedAt: Date;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  usageRecordedAt: Date;
  /** Tool names the Answer called, one entry per call, in order. */
  tools: string[];
  /** `route` of the preceding user turn's current view, as stored. */
  route: string | null;
}

export interface AgentMetrics {
  from: Date;
  to: Date;
  turns: number;
  turnsUnrecorded: number;
  conversations: number;
  newConversations: number;
  users: number;
  totalCostUsd: number;
  costPerTurnUsd: number | null;
  costPerTurnP95Usd: number | null;
  costPerConversationUsd: number | null;
  latencyMedianMs: number | null;
  latencyP95Ms: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  inputTokensPerTurn: number | null;
  outputTokensPerTurn: number | null;
  toolCallsPerTurn: number | null;
  turnsWithoutTools: number;
  turnsWithManyToolCalls: number;
  budgetLimitUsd: number;
  budgetHits: number;
  byModel: Array<{ model: string; turns: number; costUsd: number; inputTokens: number; outputTokens: number }>;
  byTool: Array<{ tool: string; calls: number; turns: number }>;
  byPage: Array<{ page: string; turns: number }>;
  weekly: Array<{
    isoWeek: string;
    weekStart: Date;
    isPartial: boolean;
    turns: number;
    conversations: number;
    users: number;
    costUsd: number;
    costPerTurnUsd: number | null;
    latencyMedianMs: number | null;
    inputTokensPerTurn: number | null;
    toolCallsPerTurn: number | null;
    models: string[];
  }>;
}

/** One recent question, for the admin's list. Never carries the user. */
export interface AgentQuestionRow {
  conversationId: string;
  askedAt: Date;
  question: string;
  route: string | null;
}

export interface AgentQuestion {
  askedAt: Date;
  question: string;
  page: string;
}

export interface AgentMetricsOptions {
  /** The daily per-user budget, so user-days that reached it can be counted. */
  budgetLimitUsd: number;
}

/** The first path segment of a route (`/event/abc` is `/event`); ids never reach the metric. */
export function pageOf(route: string | null | undefined): string {
  if (!route) return UNKNOWN;
  const path = route.split(/[?#]/, 1)[0] ?? "";
  const segment = path.split("/").find((s) => s.length > 0);
  return segment ? `/${segment}` : "/";
}

/** The arithmetic mean, or null with no values. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The median (the mean of the two middle values for an even count), or null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The nearest-rank 95th percentile, or null. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function numbers(rows: AgentTurnRow[], pick: (r: AgentTurnRow) => number | null): number[] {
  return rows.flatMap((r) => {
    const v = pick(r);
    return v == null ? [] : [v];
  });
}

/** The metric over the turns in range. */
export function summarise(
  rows: AgentTurnRow[],
  range: { from: Date; to: Date },
  options: AgentMetricsOptions & { turnsUnrecorded?: number },
): AgentMetrics {
  const costs = numbers(rows, (r) => r.costUsd);
  const latencies = numbers(rows, (r) => r.latencyMs);
  const inputs = numbers(rows, (r) => r.inputTokens);
  const outputs = numbers(rows, (r) => r.outputTokens);
  const totalCostUsd = costs.reduce((a, b) => a + b, 0);
  const conversations = new Set(rows.map((r) => r.conversationId));
  const newConversations = new Set(
    rows
      .filter((r) => r.conversationCreatedAt >= range.from && r.conversationCreatedAt <= range.to)
      .map((r) => r.conversationId),
  );

  // Budget hits: user-days whose recorded spend reached the limit. The
  // budget is checked before a turn, so a day can end a little over it.
  const spendByUserDay = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.userId}:${utcDay(r.usageRecordedAt)}`;
    spendByUserDay.set(key, (spendByUserDay.get(key) ?? 0) + (r.costUsd ?? 0));
  }
  let budgetHits = 0;
  for (const spent of spendByUserDay.values()) if (spent >= options.budgetLimitUsd) budgetHits++;

  const byModel = new Map<string, AgentMetrics["byModel"][number]>();
  const byTool = new Map<string, { calls: number; turns: number }>();
  const byPage = new Map<string, number>();
  for (const r of rows) {
    const model = r.model ?? UNKNOWN;
    const m = byModel.get(model) ?? { model, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    m.turns++;
    m.costUsd += r.costUsd ?? 0;
    m.inputTokens += r.inputTokens ?? 0;
    m.outputTokens += r.outputTokens ?? 0;
    byModel.set(model, m);
    for (const tool of new Set(r.tools)) {
      const t = byTool.get(tool) ?? { calls: 0, turns: 0 };
      t.turns++;
      byTool.set(tool, t);
    }
    for (const tool of r.tools) byTool.get(tool)!.calls++;
    const page = pageOf(r.route);
    byPage.set(page, (byPage.get(page) ?? 0) + 1);
  }

  const weekly: AgentMetrics["weekly"] = [];
  const weekRows = new Map<number, AgentTurnRow[]>();
  const lastWeek = startOfIsoWeek(range.to).getTime();
  for (let start = startOfIsoWeek(range.from).getTime(); start <= lastWeek; start += WEEK_MS) {
    weekRows.set(start, []);
  }
  for (const r of rows) weekRows.get(startOfIsoWeek(r.usageRecordedAt).getTime())?.push(r);
  for (const [start, inWeek] of weekRows) {
    const weekCosts = numbers(inWeek, (r) => r.costUsd);
    weekly.push({
      isoWeek: isoWeekLabel(new Date(start)),
      weekStart: new Date(start),
      // As in time to detection: `to` is inclusive.
      isPartial: start < range.from.getTime() || start + WEEK_MS > range.to.getTime() + 1,
      turns: inWeek.length,
      conversations: new Set(inWeek.map((r) => r.conversationId)).size,
      users: new Set(inWeek.map((r) => r.userId)).size,
      costUsd: weekCosts.reduce((a, b) => a + b, 0),
      costPerTurnUsd: mean(weekCosts),
      latencyMedianMs: median(numbers(inWeek, (r) => r.latencyMs)),
      inputTokensPerTurn: mean(numbers(inWeek, (r) => r.inputTokens)),
      toolCallsPerTurn: mean(inWeek.map((r) => r.tools.length)),
      models: [...new Set(inWeek.map((r) => r.model ?? UNKNOWN))].sort(),
    });
  }

  return {
    from: range.from,
    to: range.to,
    turns: rows.length,
    turnsUnrecorded: options.turnsUnrecorded ?? 0,
    conversations: conversations.size,
    newConversations: newConversations.size,
    users: new Set(rows.map((r) => r.userId)).size,
    totalCostUsd,
    costPerTurnUsd: mean(costs),
    costPerTurnP95Usd: p95(costs),
    costPerConversationUsd: conversations.size === 0 ? null : totalCostUsd / conversations.size,
    latencyMedianMs: median(latencies),
    latencyP95Ms: p95(latencies),
    totalInputTokens: inputs.reduce((a, b) => a + b, 0),
    totalOutputTokens: outputs.reduce((a, b) => a + b, 0),
    inputTokensPerTurn: mean(inputs),
    outputTokensPerTurn: mean(outputs),
    toolCallsPerTurn: mean(rows.map((r) => r.tools.length)),
    turnsWithoutTools: rows.filter((r) => r.tools.length === 0).length,
    turnsWithManyToolCalls: rows.filter((r) => r.tools.length > MANY_TOOL_CALLS).length,
    budgetLimitUsd: options.budgetLimitUsd,
    budgetHits,
    byModel: [...byModel.values()].sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model)),
    byTool: [...byTool.entries()]
      .map(([tool, t]) => ({ tool, ...t }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    byPage: [...byPage.entries()]
      .map(([page, turns]) => ({ page, turns }))
      .sort((a, b) => b.turns - a.turns || a.page.localeCompare(b.page)),
    weekly,
  };
}

/**
 * The tool calls of an Answer, from its stored parts. clear-mvp's Mastra
 * memory stores an Answer as `{ format: 2, parts: [...] }`; a tool call is a
 * `tool-invocation` part (its name under `toolInvocation.toolName`) or, in the
 * AI SDK's newer shape, a `tool-<name>` part. Anything else is ignored.
 */
const TOOL_CALLS_SQL = Prisma.sql`
  COALESCE((
    SELECT array_agg(
      COALESCE(p->'toolInvocation'->>'toolName', p->>'toolName', substr(p->>'type', 6))
      ORDER BY ord
    )
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(a."content"->'parts') = 'array' THEN a."content"->'parts' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS parts(p, ord)
    WHERE p->>'type' = 'tool-invocation' OR p->>'type' LIKE 'tool-%'
  ), ARRAY[]::text[])`;

/** The turns in range: every Answer whose usage was recorded in it. */
export async function fetchAgentTurns(prisma: PrismaClient, range: { from: Date; to: Date }): Promise<AgentTurnRow[]> {
  return prisma.$queryRaw<AgentTurnRow[]>`
    SELECT a."conversation_id" AS "conversationId",
      c."user_id" AS "userId",
      c."created_at" AS "conversationCreatedAt",
      a."model",
      a."input_tokens" AS "inputTokens",
      a."output_tokens" AS "outputTokens",
      a."cost_usd" AS "costUsd",
      a."latency_ms" AS "latencyMs",
      a."usage_recorded_at" AS "usageRecordedAt",
      ${TOOL_CALLS_SQL} AS "tools",
      q."current_view"->>'route' AS "route"
    FROM "conversation_messages" a
    JOIN "conversations" c ON c."id" = a."conversation_id"
    LEFT JOIN LATERAL (
      SELECT u."current_view"
      FROM "conversation_messages" u
      WHERE u."conversation_id" = a."conversation_id"
        AND u."role" = 'user'
        AND u."created_at" <= a."created_at"
      ORDER BY u."created_at" DESC
      LIMIT 1
    ) q ON true
    WHERE a."role" = 'assistant'
      AND a."usage_recorded_at" >= ${range.from}
      AND a."usage_recorded_at" <= ${range.to}
    ORDER BY a."usage_recorded_at"
  `;
}

/** Answers written in range whose usage was never recorded. */
export async function countUnrecordedTurns(prisma: PrismaClient, range: { from: Date; to: Date }): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count"
    FROM "conversation_messages"
    WHERE "role" = 'assistant'
      AND "usage_recorded_at" IS NULL
      AND "created_at" >= ${range.from}
      AND "created_at" <= ${range.to}
  `;
  return rows[0]?.count ?? 0;
}

/**
 * The newest questions asked in range (user turns by `createdAt`), newest
 * first, each cut to {@link QUESTION_CHARS}. Carries the Conversation id so
 * the caller can audit the read; never the user.
 */
export async function fetchRecentQuestions(
  prisma: PrismaClient,
  range: { from: Date; to: Date },
  first: number,
): Promise<AgentQuestionRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(first)), MAX_RECENT_QUESTIONS);
  return prisma.$queryRaw<AgentQuestionRow[]>`
    SELECT u."conversation_id" AS "conversationId",
      u."created_at" AS "askedAt",
      left(COALESCE((
        SELECT string_agg(p->>'text', ' ' ORDER BY ord)
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(u."content"->'parts') = 'array' THEN u."content"->'parts' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS parts(p, ord)
        WHERE p->>'type' = 'text'
      ), ''), ${QUESTION_CHARS}) AS "question",
      u."current_view"->>'route' AS "route"
    FROM "conversation_messages" u
    WHERE u."role" = 'user'
      AND u."created_at" >= ${range.from}
      AND u."created_at" <= ${range.to}
    ORDER BY u."created_at" DESC
    LIMIT ${limit}
  `;
}

/** Agent usage over the requested range. */
export async function computeAgentMetrics(
  prisma: PrismaClient,
  input: AgentMetricsInput,
  options: AgentMetricsOptions,
  now: Date = new Date(),
): Promise<AgentMetrics> {
  const range = resolveRange(input, now);
  const [rows, turnsUnrecorded] = await Promise.all([
    fetchAgentTurns(prisma, range),
    countUnrecordedTurns(prisma, range),
  ]);
  return summarise(rows, range, { ...options, turnsUnrecorded });
}
