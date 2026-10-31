import type { Context } from "../context.js";
import { logActivityOrThrow } from "../utils/activity-log.js";
import { requireRole } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import {
  computeAgentMetrics,
  DEFAULT_RECENT_QUESTIONS,
  fetchRecentQuestions,
  pageOf,
  type AgentMetrics,
  type AgentMetricsInput,
  type AgentQuestion,
} from "../services/agent-metrics.js";
import { computeDetectionMetrics, type DetectionMetricsInput } from "../services/detection-metrics.js";
import {
  computeLocationPrecisionMetrics,
  type LocationPrecisionMetricsInput,
} from "../services/location-precision-metrics.js";

/** Platform metrics for the admin /metrics page in clear-mvp. Admin only. */
export const metricsResolvers = {
  Query: {
    detectionMetrics: async (
      _parent: unknown,
      args: { input?: DetectionMetricsInput | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return computeDetectionMetrics(context.prisma, args.input ?? {});
    },
    locationPrecisionMetrics: async (
      _parent: unknown,
      args: { input?: LocationPrecisionMetricsInput | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return computeLocationPrecisionMetrics(context.prisma, args.input ?? {});
    },
    agentMetrics: async (
      _parent: unknown,
      args: { input?: AgentMetricsInput | null },
      context: Context,
    ): Promise<AgentMetrics> => {
      requireRole(context, ["admin"]);
      return computeAgentMetrics(context.prisma, args.input ?? {}, { budgetLimitUsd: env.AGENT_DAILY_BUDGET_USD });
    },
  },
  AgentMetrics: {
    /**
     * Question text is read only when this field is selected, and the read
     * is logged as `conversation.admin_read` first (as `userConversations`
     * does): the admin sees the questions, never without a record of it.
     */
    recentQuestions: async (
      parent: AgentMetrics,
      args: { first?: number | null },
      context: Context,
    ): Promise<AgentQuestion[]> => {
      const admin = requireRole(context, ["admin"]);
      const range = { from: parent.from, to: parent.to };
      const rows = await fetchRecentQuestions(context.prisma, range, args.first ?? DEFAULT_RECENT_QUESTIONS);
      if (rows.length > 0) {
        await logActivityOrThrow(context.prisma, {
          userId: admin.id,
          action: "conversation.admin_read",
          resourceType: "conversation",
          metadata: {
            listing: true,
            via: "agentMetrics.recentQuestions",
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            conversationIds: [...new Set(rows.map((r) => r.conversationId))],
          },
        });
      }
      return rows.map((r) => ({ askedAt: r.askedAt, question: r.question, page: pageOf(r.route) }));
    },
  },
};
