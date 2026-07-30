import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireContentReader } from "../utils/auth-guard.js";
import { buildLocationFilterForTeam } from "../utils/location-scope.js";

// v1 has exactly one open state; a resubmit updates the single open row per
// signal (enforced by @@unique([signalId, status])).
const OPEN_STATUS = "consideration";
const NOTE_MAX = 2000;
const NAME_MAX = 500;

interface SubmitInput {
  signalId: string;
  note?: string | null;
  proposedLng?: number | null;
  proposedLat?: number | null;
  proposedName?: string | null;
}

/** Trim to null (empty → null); reject when over `max`. */
function trimOrNull(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new GraphQLError(`${field} must be at most ${max} characters.`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return trimmed;
}

export const signalLocationChallengeResolvers = {
  Query: {
    signalLocationChallenges: async (
      _parent: unknown,
      args: { teamId?: string | null; status?: string | null },
      context: Context,
    ) => {
      requireContentReader(context);
      const status = args.status ?? OPEN_STATUS;
      // Team scope is a view filter (like the `signals` query): filter to
      // challenges whose Signal falls within the team's locations. No teamId =
      // global feed. A team with no locations returns undefined = no filter.
      const signalFilter = args.teamId
        ? await buildLocationFilterForTeam(context.prisma, args.teamId)
        : undefined;
      return context.prisma.signalLocationChallenges.findMany({
        where: {
          status,
          ...(signalFilter ? { signal: signalFilter } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    submitSignalLocationChallenge: async (
      _parent: unknown,
      { input }: { input: SubmitInput },
      context: Context,
    ) => {
      const user = requireContentReader(context);

      // 1. Signal must exist. (Team scope is a view filter, not a hard access
      //    gate here — mirrors the signal(id) / signals queries.)
      const signal = await context.prisma.signals.findUnique({
        where: { id: input.signalId },
        select: { id: true },
      });
      if (!signal) {
        throw new GraphQLError(`Signal ${input.signalId} not found.`, {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // 2. Point pair: both set or both omitted; validate ranges when present.
      const hasLng = input.proposedLng != null;
      const hasLat = input.proposedLat != null;
      if (hasLng !== hasLat) {
        throw new GraphQLError(
          "proposedLng and proposedLat must both be set, or both omitted.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      const proposedLng = hasLng ? input.proposedLng! : null;
      const proposedLat = hasLat ? input.proposedLat! : null;
      if (proposedLng !== null && (!Number.isFinite(proposedLng) || proposedLng < -180 || proposedLng > 180)) {
        throw new GraphQLError("proposedLng must be a finite number in [-180, 180].", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (proposedLat !== null && (!Number.isFinite(proposedLat) || proposedLat < -90 || proposedLat > 90)) {
        throw new GraphQLError("proposedLat must be a finite number in [-90, 90].", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const note = trimOrNull(input.note, NOTE_MAX, "note");
      const proposedName = trimOrNull(input.proposedName, NAME_MAX, "proposedName");

      // 3. Upsert the single open row for this signal — resubmit replaces it.
      //    Never writes into the signal's own origin/destination/location.
      const fields = { createdBy: user.id, note, proposedLng, proposedLat, proposedName };
      return context.prisma.signalLocationChallenges.upsert({
        where: { signalId_status: { signalId: input.signalId, status: OPEN_STATUS } },
        create: { signalId: input.signalId, status: OPEN_STATUS, ...fields },
        update: fields,
      });
    },
  },

  Signal: {
    locationChallenge: (
      parent: { id: string; locationChallenge?: unknown },
      _args: unknown,
      { prisma }: Context,
    ) => {
      // Fast path when preloaded via a deep include; else load the open row.
      if (parent.locationChallenge !== undefined) return parent.locationChallenge;
      return prisma.signalLocationChallenges.findFirst({
        where: { signalId: parent.id, status: OPEN_STATUS },
      });
    },
  },

  SignalLocationChallenge: {
    hasProposedPoint: (parent: { proposedLng: number | null; proposedLat: number | null }) =>
      parent.proposedLng != null && parent.proposedLat != null,
  },
};
