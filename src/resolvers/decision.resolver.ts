/**
 * The decisions feed (ADR-0024): the pipeline reads human decisions in
 * sequence order and treats each one as a constraint on its gold proposals.
 * Read-only; `recordDecision` is the only writer.
 */
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

/** Rows per page. */
export const DECISIONS_PAGE_SIZE = 500;

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

export const decisionResolvers = {
  Query: {
    decisions: async (_parent: unknown, args: { sinceSequence: number }, context: Context) => {
      requireRole(context, ["admin", "pipeline"]);
      if (!Number.isInteger(args.sinceSequence) || args.sinceSequence < 0) {
        throw badInput("sinceSequence must be a whole number, 0 or more");
      }
      const items = await context.prisma.decisionRecords.findMany({
        where: { sequence: { gt: BigInt(args.sinceSequence) } },
        orderBy: { sequence: "asc" },
        take: DECISIONS_PAGE_SIZE,
      });
      const last = items.at(-1);
      return { items, lastSequence: last ? Number(last.sequence) : args.sinceSequence };
    },
  },
  DecisionRecord: {
    sequence: (parent: { sequence: bigint }) => Number(parent.sequence),
  },
};
