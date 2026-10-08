/**
 * Estimates (CLEAR Domain Ontology v0.3.0): figures for one metric on an
 * Event. Read-only here — the table is append-only by construction (the
 * migration's `estimates_immutable` trigger), and the first writer is the
 * decision on a web case (V4).
 */

import type { Context } from "../context.js";
import type { EstimateMetric, Prisma } from "../generated/prisma/client.js";
import { requireContentReader } from "../utils/auth-guard.js";

type EstimateRow = Prisma.estimateGetPayload<Record<string, never>>;

export const estimateResolvers = {
  Estimate: {
    event: (parent: EstimateRow, _args: unknown, context: Context) =>
      context.prisma.events.findUniqueOrThrow({ where: { id: parent.eventId } }),
    supersedes: (parent: EstimateRow, _args: unknown, context: Context) =>
      parent.supersedesId
        ? context.prisma.estimate.findUnique({ where: { id: parent.supersedesId } })
        : null,
    supersededBy: (parent: EstimateRow, _args: unknown, context: Context) =>
      context.prisma.estimate.findUnique({ where: { supersedesId: parent.id } }),
    createdBy: (parent: EstimateRow, _args: unknown, context: Context) =>
      parent.createdById
        ? context.prisma.user.findUnique({ where: { id: parent.createdById } })
        : null,
  },

  Event: {
    // Follows the Event's visibility: the same reader gate as `event(id)`.
    estimates: (
      parent: { id: string },
      args: { metric?: EstimateMetric | null; current?: boolean | null },
      context: Context,
    ) => {
      requireContentReader(context);
      return context.prisma.estimate.findMany({
        where: {
          eventId: parent.id,
          ...(args.metric ? { metric: args.metric } : {}),
          ...(args.current ? { supersededBy: { is: null } } : {}),
        },
        // `id` breaks estimatedAt ties: the backfill stamped every row with
        // the same instant.
        orderBy: [{ estimatedAt: "desc" }, { id: "desc" }],
      });
    },
  },
};
