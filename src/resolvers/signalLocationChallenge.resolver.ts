import { GraphQLError } from "graphql";
import { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import {
  isPlatformAdmin,
  requireContentReader,
  requireNonWorkerContentReader,
} from "../utils/auth-guard.js";
import { buildLocationFilterForTeam, getTeamScopeLocationIds } from "../utils/location-scope.js";
import {
  createPointLocation,
  findOrCreateLandmarkL4,
  resolveContainingAdminArea,
} from "../utils/geo-resolve.js";
import { logActivity } from "../utils/activity-log.js";

// ─── Signal Location challenges (Exponential #836) ───────────────────────────
// An analyst challenges a Signal's location for their team, optionally with a
// corrected point; that team's admin writes the proposed point onto the
// Signal, places a different one, or declines. Only the Signal changes: which
// Event it belongs to does not.

/** The open state, kept from Location trust v1 (the map queries it). */
export const OPEN_CHALLENGE_STATUS = "consideration";
/** Replaced by a newer challenge on the same Signal. */
const SUPERSEDED = "superseded";
const STATUSES: ReadonlySet<string> = new Set([
  OPEN_CHALLENGE_STATUS,
  "accepted",
  "corrected",
  "declined",
  SUPERSEDED,
]);
const FILER_ROLE = "analyst";
const DECIDER_ROLE = "team_admin";
const NOTE_MAX = 2000;
const NAME_MAX = 500;
/** Page size and cap of the Inbox list. */
const TO_DECIDE_MAX = 200;

type Decision = "ACCEPT" | "CORRECT" | "DECLINE";

interface SubmitInput {
  signalId: string;
  teamId: string;
  note?: string | null;
  proposedLng?: number | null;
  proposedLat?: number | null;
  proposedName?: string | null;
}

interface PointInput {
  lat: number;
  lng: number;
  name?: string | null;
}

interface SignalLocations {
  originId: string | null;
  destinationId: string | null;
  locationId: string | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
}

/** Trim to null (empty → null); reject when over `max`. */
function trimText(value: string | null | undefined, max: number, field: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw badInput(`${field} must be at most ${max} characters.`);
  return trimmed;
}

function assertPoint(lat: number, lng: number, field: string): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw badInput(`${field} latitude must be a finite number in [-90, 90].`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw badInput(`${field} longitude must be a finite number in [-180, 180].`);
  }
}

/** The caller's role on `teamId`, or null. */
async function teamRole(context: Context, userId: string, teamId: string): Promise<string | null> {
  const membership = await context.prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
}

/** A platform admin, or the team_admin of `teamId`. A challenge with no team
 *  (filed before teams were recorded) is for a platform admin. */
async function requireDecider(context: Context, teamId: string | null) {
  const user = requireNonWorkerContentReader(context);
  if (isPlatformAdmin(user)) return user;
  if (teamId && (await teamRole(context, user.id, teamId)) === DECIDER_ROLE) return user;
  throw forbidden("Requires the team's team_admin, or a platform admin");
}

/** The team's area as a test on location ids: its scope locations and
 *  everything under them. A team with no scope is global monitoring and
 *  covers every place. */
async function teamArea(context: Context, teamId: string): Promise<(locationId: string) => boolean> {
  const scope = await getTeamScopeLocationIds(context.prisma, teamId);
  if (!scope) return () => true;
  const ids = new Set(scope);
  return (locationId) => ids.has(locationId);
}

/** Whether the team works on the Signal: one of its locations is in the
 *  team's area. A Signal with no location at all is open to any team. */
function signalInArea(inArea: (locationId: string) => boolean, signal: SignalLocations): boolean {
  const locs = [signal.originId, signal.destinationId, signal.locationId].filter(
    (x): x is string => Boolean(x),
  );
  return locs.length === 0 || locs.some(inArea);
}

/** The location a Signal shows: general, else origin, else destination. */
function shownLocation(signal: SignalLocations): string | null {
  return signal.locationId ?? signal.originId ?? signal.destinationId ?? null;
}

function signalNotFound(signalId: string): GraphQLError {
  return new GraphQLError(`Signal ${signalId} not found.`, { extensions: { code: "NOT_FOUND" } });
}

function outsideTeamScope(): GraphQLError {
  return forbidden("This signal is outside the team's location scope");
}

/** A team corrects its Signals only within its own area; placing one beyond
 *  it (in another country, say) is for a platform admin. */
function placeOutsideTeamArea(): GraphQLError {
  return forbidden("The place is outside the team's area; a platform admin can place the signal there");
}

function placeOutsideCoverage(): GraphQLError {
  return badInput("The place is outside the areas CLEAR covers.");
}

function decidedMeanwhile(): GraphQLError {
  return new GraphQLError("This challenge was decided or replaced in the meantime", {
    extensions: { code: "CONFLICT" },
  });
}

function couldNotPlace(): GraphQLError {
  return new GraphQLError("The place could not be placed", {
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  });
}

/** The level-4 point to write for a place, under `areaId` (the admin area
 *  that contains it, which the checks passed). With a name, a same-name point
 *  within 100 m under that area is reused, else one is created tagged
 *  landmark-geocoded so the app shows that name (a village, not its district).
 *  Without one, a nearby point with the same parent is reused or a plain one
 *  created, which the app shows by its admin area's name. Both are
 *  idempotent, so a point left behind by a lost race is reused next time. */
async function pointFor(
  context: Context,
  place: { lat: number; lng: number; name: string | null },
  areaId: string,
): Promise<string> {
  if (!place.name) {
    return (await createPointLocation(context.prisma, place.lat, place.lng)).id;
  }
  const found = await findOrCreateLandmarkL4(context.prisma, {
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    kind: "admin",
    withinId: areaId,
  });
  if (!found.locationId) throw couldNotPlace();
  return found.locationId;
}

/** The country (level 0) of a point about to be written, after checking it
 *  sits under `areaId`: the point and country written are the ones the
 *  checks passed, never a neighbour's. */
async function countryOfPointUnder(
  context: Context,
  pointId: string,
  areaId: string,
): Promise<string | null> {
  const point = await context.prisma.locations.findUnique({
    where: { id: pointId },
    select: { ancestorIds: true },
  });
  if (!point || !point.ancestorIds.includes(areaId)) throw couldNotPlace();
  const country = await context.prisma.locations.findFirst({
    where: { id: { in: point.ancestorIds }, level: 0 },
    select: { id: true },
  });
  return country?.id ?? null;
}

export const signalLocationChallengeResolvers = {
  Query: {
    signalLocationChallenges: async (
      _parent: unknown,
      args: { teamId?: string | null; status?: string | null },
      context: Context,
    ) => {
      requireContentReader(context);
      const status = args.status ?? OPEN_CHALLENGE_STATUS;
      if (!STATUSES.has(status)) {
        throw badInput(`status must be one of: ${[...STATUSES].join(", ")}.`);
      }
      // Team scope is a view filter (like `signals`): challenges whose Signal
      // falls within the team's locations. No teamId = global feed; a team with
      // no scope locations = no filter.
      const signalFilter = args.teamId
        ? await buildLocationFilterForTeam(context.prisma, args.teamId)
        : undefined;
      return context.prisma.signalLocationChallenges.findMany({
        where: { status, ...(signalFilter ? { signal: signalFilter } : {}) },
        orderBy: { createdAt: "desc" },
      });
    },

    signalLocationChallengesToDecide: async (
      _parent: unknown,
      args: { teamId?: string | null; first?: number | null },
      context: Context,
    ) => {
      const user = requireNonWorkerContentReader(context);
      const take = args.first ?? TO_DECIDE_MAX;
      if (!Number.isInteger(take) || take < 1 || take > TO_DECIDE_MAX) {
        throw badInput(`first must be between 1 and ${TO_DECIDE_MAX}.`);
      }
      let teamFilter: Prisma.signalLocationChallengesWhereInput;
      if (isPlatformAdmin(user)) {
        teamFilter = args.teamId ? { teamId: args.teamId } : {};
      } else {
        const adminTeams = (
          await context.prisma.teamMembers.findMany({
            where: { userId: user.id, role: DECIDER_ROLE },
            select: { teamId: true },
          })
        ).map((m) => m.teamId);
        if (args.teamId) {
          if (!adminTeams.includes(args.teamId)) {
            throw forbidden("Requires the team's team_admin, or a platform admin");
          }
          teamFilter = { teamId: args.teamId };
        } else {
          // Not a decider anywhere: nothing to decide.
          if (adminTeams.length === 0) return [];
          teamFilter = { teamId: { in: adminTeams } };
        }
      }
      return context.prisma.signalLocationChallenges.findMany({
        // Nobody decides their own challenge, so it isn't in their Inbox.
        where: { status: OPEN_CHALLENGE_STATUS, createdBy: { not: user.id }, ...teamFilter },
        orderBy: { createdAt: "desc" },
        take,
      });
    },

    locationPlacement: async (
      _parent: unknown,
      args: { lat: number; lng: number },
      context: Context,
    ) => {
      requireContentReader(context);
      assertPoint(args.lat, args.lng, "The point's");
      const placed = await resolveContainingAdminArea(context.prisma, args.lat, args.lng);
      if (!placed) return null;
      return context.prisma.locations.findUnique({ where: { id: placed.id } });
    },
  },

  Mutation: {
    submitSignalLocationChallenge: async (
      _parent: unknown,
      { input }: { input: SubmitInput },
      context: Context,
    ) => {
      const user = requireNonWorkerContentReader(context);
      if (isPlatformAdmin(user)) {
        const team = await context.prisma.teams.findUnique({
          where: { id: input.teamId },
          select: { id: true },
        });
        if (!team) throw new GraphQLError("Team not found", { extensions: { code: "NOT_FOUND" } });
      } else if ((await teamRole(context, user.id, input.teamId)) !== FILER_ROLE) {
        throw forbidden("Requires the analyst role on this team");
      }

      // Point pair: both set or both omitted; ranges when present.
      const hasLng = input.proposedLng != null;
      const hasLat = input.proposedLat != null;
      if (hasLng !== hasLat) {
        throw badInput("proposedLng and proposedLat must both be set, or both omitted.");
      }
      const proposedLng = input.proposedLng ?? null;
      const proposedLat = input.proposedLat ?? null;
      if (proposedLat !== null && proposedLng !== null) {
        assertPoint(proposedLat, proposedLng, "The proposed point's");
      }
      const note = trimText(input.note, NOTE_MAX, "note");
      const proposedName = trimText(input.proposedName, NAME_MAX, "proposedName");

      const signal = await context.prisma.signals.findUnique({
        where: { id: input.signalId },
        select: { id: true, originId: true, destinationId: true, locationId: true },
      });
      if (!signal) throw signalNotFound(input.signalId);

      const inArea = await teamArea(context, input.teamId);
      if (!signalInArea(inArea, signal)) throw outsideTeamScope();

      // Fail now rather than on accept: a point outside every loaded admin
      // area would leave the Signal with no country or district. Inside an
      // area, not near one: a place just across a border is not its
      // neighbour's.
      if (proposedLat !== null && proposedLng !== null) {
        const placement = await resolveContainingAdminArea(context.prisma, proposedLat, proposedLng);
        if (!placement) throw placeOutsideCoverage();
        if (!isPlatformAdmin(user) && !inArea(placement.id)) throw placeOutsideTeamArea();
      }

      const fields = {
        teamId: input.teamId,
        createdBy: user.id,
        note,
        proposedLng,
        proposedLat,
        proposedName,
        previousLocationId: shownLocation(signal),
      };
      // One open challenge per Signal (a partial unique index backs this). A
      // new one supersedes it instead of rewriting it, so a decision always
      // applies to the exact challenge it was made on, and the earlier one
      // stays as history.
      let challenge;
      try {
        challenge = await context.prisma.$transaction(async (tx) => {
          // Lock the Signal first, as deciding does. Otherwise this insert's
          // foreign-key check waits on a Signal a decision has locked, while
          // holding the open challenge the decision waits on: a deadlock.
          await tx.$queryRaw`SELECT id FROM "signals" WHERE id = ${signal.id} FOR UPDATE`;
          await tx.signalLocationChallenges.updateMany({
            where: { signalId: signal.id, status: OPEN_CHALLENGE_STATUS },
            data: { status: SUPERSEDED },
          });
          return tx.signalLocationChallenges.create({
            data: { signalId: signal.id, status: OPEN_CHALLENGE_STATUS, ...fields },
          });
        });
      } catch (err) {
        // Another challenge on this Signal was filed at the same moment.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new GraphQLError("Another challenge on this signal was just filed; try again", {
            extensions: { code: "CONFLICT" },
          });
        }
        throw err;
      }

      void logActivity(context.prisma, {
        userId: user.id,
        action: "signal.location_challenge.file",
        resourceType: "signal",
        resourceId: signal.id,
        metadata: { challengeId: challenge.id, teamId: input.teamId, proposedLat, proposedLng },
      });
      return challenge;
    },

    decideSignalLocationChallenge: async (
      _parent: unknown,
      args: { id: string; decision: Decision; point?: PointInput | null },
      context: Context,
    ) => {
      requireNonWorkerContentReader(context);
      const challenge = await context.prisma.signalLocationChallenges.findUnique({
        where: { id: args.id },
      });
      if (!challenge) {
        throw new GraphQLError("Location challenge not found", { extensions: { code: "NOT_FOUND" } });
      }
      const user = await requireDecider(context, challenge.teamId);
      // Approval means a second person: the filer never decides their own.
      if (challenge.createdBy === user.id) {
        throw forbidden("You filed this challenge, so another admin decides it");
      }
      if (challenge.status !== OPEN_CHALLENGE_STATUS) {
        throw new GraphQLError(
          challenge.status === SUPERSEDED
            ? "This challenge was replaced by a newer one"
            : `This challenge is already ${challenge.status}`,
          { extensions: { code: "CONFLICT" } },
        );
      }

      const point = args.point ?? null;
      if (args.decision === "CORRECT") {
        if (!point) throw badInput("CORRECT needs the point to write.");
        assertPoint(point.lat, point.lng, "The point's");
      } else if (point) {
        throw badInput("Only CORRECT takes a point.");
      }
      const decided = { decidedBy: user.id, decidedAt: new Date() };

      if (args.decision === "DECLINE") {
        // Conditional on still open, so a concurrent decision wins once.
        const { count } = await context.prisma.signalLocationChallenges.updateMany({
          where: { id: challenge.id, status: OPEN_CHALLENGE_STATUS },
          data: { status: "declined", ...decided },
        });
        if (count === 0) throw decidedMeanwhile();
        void logActivity(context.prisma, {
          userId: user.id,
          action: "signal.location_challenge.decline",
          resourceType: "signal",
          resourceId: challenge.signalId,
          metadata: { challengeId: challenge.id },
        });
        return context.prisma.signalLocationChallenges.findUnique({ where: { id: challenge.id } });
      }

      let place: { lat: number; lng: number; name: string | null };
      if (args.decision === "CORRECT" && point) {
        place = { lat: point.lat, lng: point.lng, name: trimText(point.name, NAME_MAX, "point.name") };
      } else if (challenge.proposedLat !== null && challenge.proposedLng !== null) {
        place = { lat: challenge.proposedLat, lng: challenge.proposedLng, name: challenge.proposedName };
      } else {
        throw badInput("This challenge proposes no point: place one with CORRECT, or DECLINE it.");
      }

      // Checked before a point is created, so a challenge that can no longer
      // be accepted creates nothing. The Signal is checked again under a lock.
      const inArea = challenge.teamId ? await teamArea(context, challenge.teamId) : () => true;
      const placement = await resolveContainingAdminArea(context.prisma, place.lat, place.lng);
      if (!placement) throw placeOutsideCoverage();
      if (!isPlatformAdmin(user) && !inArea(placement.id)) throw placeOutsideTeamArea();
      // The team may have lost the Signal since it was filed (its scope
      // changed, or a source revision moved it).
      const signal = await context.prisma.signals.findUnique({
        where: { id: challenge.signalId },
        select: { originId: true, destinationId: true, locationId: true },
      });
      if (!signal) throw signalNotFound(challenge.signalId);
      if (!signalInArea(inArea, signal)) throw outsideTeamScope();

      const pointId = await pointFor(context, place, placement.id);
      const countryId = await countryOfPointUnder(context, pointId, placement.id);
      const status = args.decision === "CORRECT" ? "corrected" : "accepted";

      const previous = await context.prisma.$transaction(async (tx) => {
        // Serialise writes to this Signal and re-read where it is now, so a
        // location written since the check above is not overwritten by a team
        // that no longer covers the Signal.
        await tx.$queryRaw`SELECT id FROM "signals" WHERE id = ${challenge.signalId} FOR UPDATE`;
        const current = await tx.signals.findUnique({
          where: { id: challenge.signalId },
          select: {
            originId: true,
            destinationId: true,
            locationId: true,
            countries: { select: { id: true } },
          },
        });
        if (!current) throw signalNotFound(challenge.signalId);
        if (!signalInArea(inArea, current)) throw outsideTeamScope();

        // Conditional on still open. An open challenge is never rewritten (a
        // new one supersedes it), so this writes exactly the place read above.
        const { count } = await tx.signalLocationChallenges.updateMany({
          where: { id: challenge.id, status: OPEN_CHALLENGE_STATUS },
          data: { status, appliedLocationId: pointId, ...decided },
        });
        if (count === 0) throw decidedMeanwhile();
        // "It happened here": the general location only, and the source's
        // later revisions keep it (updateSignalContent checks the stamp).
        await tx.signals.update({
          where: { id: challenge.signalId },
          data: {
            locationId: pointId,
            originId: null,
            destinationId: null,
            locationCorrectedAt: decided.decidedAt,
            ...(countryId ? { countries: { set: [{ id: countryId }] } } : {}),
          },
        });
        // What the correction overwrote, so it can be undone by hand.
        return {
          locationId: current.locationId,
          originId: current.originId,
          destinationId: current.destinationId,
          countryIds: current.countries.map((c) => c.id),
        };
      });

      void logActivity(context.prisma, {
        userId: user.id,
        action: status === "corrected" ? "signal.location_challenge.correct" : "signal.location_challenge.accept",
        resourceType: "signal",
        resourceId: challenge.signalId,
        metadata: { challengeId: challenge.id, appliedLocationId: pointId, previous },
      });
      return context.prisma.signalLocationChallenges.findUnique({ where: { id: challenge.id } });
    },
  },

  SignalLocationChallenge: {
    signal: (parent: { signalId: string }, _args: unknown, { prisma }: Context) =>
      prisma.signals.findUnique({ where: { id: parent.signalId } }),
    // Only for the team's members and platform admins, as `Query.team`: any
    // reader lists challenges, and a Team carries its members.
    team: async (parent: { teamId: string | null }, _args: unknown, context: Context) => {
      const user = context.user;
      if (!parent.teamId || !user) return null;
      if (!isPlatformAdmin(user) && !(await teamRole(context, user.id, parent.teamId))) return null;
      return context.prisma.teams.findUnique({ where: { id: parent.teamId } });
    },
    hasProposedPoint: (parent: { proposedLng: number | null; proposedLat: number | null }) =>
      parent.proposedLng != null && parent.proposedLat != null,
    proposedPlacement: async (
      parent: { proposedLng: number | null; proposedLat: number | null },
      _args: unknown,
      { prisma }: Context,
    ) => {
      if (parent.proposedLat == null || parent.proposedLng == null) return null;
      const placed = await resolveContainingAdminArea(prisma, parent.proposedLat, parent.proposedLng);
      return placed ? prisma.locations.findUnique({ where: { id: placed.id } }) : null;
    },
    previousLocation: (parent: { previousLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.previousLocationId
        ? prisma.locations.findUnique({ where: { id: parent.previousLocationId } })
        : null,
    appliedLocation: (parent: { appliedLocationId: string | null }, _args: unknown, { prisma }: Context) =>
      parent.appliedLocationId
        ? prisma.locations.findUnique({ where: { id: parent.appliedLocationId } })
        : null,
    createdByName: async (parent: { createdBy: string }, _args: unknown, { prisma }: Context) => {
      const u = await prisma.user.findUnique({ where: { id: parent.createdBy }, select: { name: true } });
      return u?.name ?? null;
    },
  },
};
