import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { isPlatformAdmin, requireAuth } from "../utils/auth-guard.js";
import { ensureDefaultTeam } from "../services/ensure-default-team.js";

// Valid team-member roles. Legacy values (lead/analyst/viewer) were folded
// into (team_admin/field_coordinator/team_member) by the Phase-3 backfill,
// so this list is intentionally the closed new set.
const TEAM_MEMBER_ROLES = [
  "team_admin",
  "field_coordinator",
  "team_member",
] as const;
type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

// Roles with admin-level privileges over a team.
const TEAM_ADMIN_ROLES: ReadonlySet<string> = new Set(["team_admin"]);

function assertTeamMemberRole(role: string): TeamMemberRole {
  if (!TEAM_MEMBER_ROLES.includes(role as TeamMemberRole)) {
    throw new GraphQLError(
      `Invalid team role "${role}". Must be one of: ${TEAM_MEMBER_ROLES.join(", ")}`,
      { extensions: { code: "BAD_USER_INPUT" } },
    );
  }
  return role as TeamMemberRole;
}

interface CreateTeamInput {
  organisationId: string;
  name: string;
  slug: string;
  description?: string;
}

interface UpdateTeamInput {
  name?: string;
  slug?: string;
  description?: string;
}

export const teamResolvers = {
  Query: {
    myTeams: async (_parent: unknown, _args: unknown, context: Context) => {
      const user = requireAuth(context);
      const memberships = await context.prisma.teamMembers.findMany({
        where: { userId: user.id },
        select: { teamId: true },
      });
      return context.prisma.teams.findMany({
        where: { id: { in: memberships.map((m) => m.teamId) } },
      });
    },

    team: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.id },
      });
      if (!team) return null;

      if (isPlatformAdmin(user)) return team;

      const membership = await context.prisma.teamMembers.findUnique({
        where: {
          teamId_userId: { teamId: args.id, userId: user.id },
        },
      });
      if (!membership) {
        throw new GraphQLError("Not a member of this team", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      return team;
    },
  },

  Mutation: {
    createTeam: async (
      _parent: unknown,
      args: { input: CreateTeamInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      await requireOrgAdminForTeam(
        context.prisma,
        user,
        args.input.organisationId,
      );

      return context.prisma.teams.create({
        data: {
          organisationId: args.input.organisationId,
          name: args.input.name,
          slug: args.input.slug,
          description: args.input.description,
          members: {
            create: {
              userId: user.id,
              role: "team_admin",
            },
          },
        },
      });
    },

    updateTeam: async (
      _parent: unknown,
      args: { id: string; input: UpdateTeamInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.id },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireTeamAdminOrOrgAdmin(
        context.prisma,
        user,
        args.id,
        team.organisationId,
      );

      return context.prisma.teams.update({
        where: { id: args.id },
        data: args.input,
      });
    },

    deleteTeam: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.id },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireOrgAdminForTeam(context.prisma, user, team.organisationId);

      await context.prisma.teams.delete({ where: { id: args.id } });
      return true;
    },

    addTeamMember: async (
      _parent: unknown,
      args: { teamId: string; userId: string; role?: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.teamId },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireTeamAdminOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      // Ensure target user is an org member
      const orgMembership = await context.prisma.organisationUsers.findUnique({
        where: {
          userId_organisationId: {
            userId: args.userId,
            organisationId: team.organisationId,
          },
        },
      });
      if (!orgMembership) {
        throw new GraphQLError(
          "User must be a member of the organisation first",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const role = args.role ? assertTeamMemberRole(args.role) : "team_member";

      const membership = await context.prisma.teamMembers.create({
        data: {
          teamId: args.teamId,
          userId: args.userId,
          role,
        },
      });

      // Seed defaultTeamId when the target user has none. First team wins;
      // subsequent adds don't overwrite an explicit choice.
      await ensureDefaultTeam(context.prisma, args.userId, args.teamId);

      return membership;
    },

    removeTeamMember: async (
      _parent: unknown,
      args: { teamId: string; userId: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.teamId },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireTeamAdminOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      try {
        await context.prisma.teamMembers.delete({
          where: {
            teamId_userId: { teamId: args.teamId, userId: args.userId },
          },
        });
        return true;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "P2025"
        ) {
          throw new GraphQLError("Team member not found", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        throw error;
      }
    },

    updateTeamMemberRole: async (
      _parent: unknown,
      args: { teamId: string; userId: string; role: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.teamId },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireTeamAdminOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      const role = assertTeamMemberRole(args.role);

      try {
        return await context.prisma.teamMembers.update({
          where: {
            teamId_userId: { teamId: args.teamId, userId: args.userId },
          },
          data: { role },
        });
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "P2025"
        ) {
          throw new GraphQLError("Team member not found", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        throw error;
      }
    },

    setTeamLocations: async (
      _parent: unknown,
      args: { teamId: string; locationIds: string[] },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const team = await context.prisma.teams.findUnique({
        where: { id: args.teamId },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireTeamAdminOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      // Replace all team locations in a transaction
      await context.prisma.$transaction([
        context.prisma.teamLocations.deleteMany({
          where: { teamId: args.teamId },
        }),
        ...args.locationIds.map((locationId) =>
          context.prisma.teamLocations.create({
            data: { teamId: args.teamId, locationId },
          }),
        ),
      ]);

      return context.prisma.teams.findUnique({ where: { id: args.teamId } });
    },

    setDefaultTeam: async (
      _parent: unknown,
      args: { teamId: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      // Verify team exists
      const team = await context.prisma.teams.findUnique({
        where: { id: args.teamId },
      });
      if (!team) {
        throw new GraphQLError("Team not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Verify membership (admins bypass)
      if (!isPlatformAdmin(user)) {
        const membership = await context.prisma.teamMembers.findUnique({
          where: {
            teamId_userId: { teamId: args.teamId, userId: user.id },
          },
        });
        if (!membership) {
          throw new GraphQLError("Not a member of this team", {
            extensions: { code: "FORBIDDEN" },
          });
        }
      }

      await context.prisma.user.update({
        where: { id: user.id },
        data: { defaultTeamId: args.teamId },
      });

      return team;
    },
  },

  Team: {
    organisation: (
      parent: { organisationId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.organisations.findUnique({
        where: { id: parent.organisationId },
      });
    },
    members: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.teamMembers.findMany({ where: { teamId: parent.id } });
    },
    locations: async (
      parent: { id: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      const teamLocs = await prisma.teamLocations.findMany({
        where: { teamId: parent.id },
        select: { locationId: true },
      });
      return prisma.locations.findMany({
        where: { id: { in: teamLocs.map((tl) => tl.locationId) } },
      });
    },
  },

  TeamMember: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
};

/** Check that user is an org owner/admin, or global admin. */
async function requireOrgAdminForTeam(
  prisma: Context["prisma"],
  user: { id: string; role?: string | null },
  orgId: string,
) {
  if (isPlatformAdmin(user)) return;

  const membership = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId: orgId },
    },
  });
  if (!membership || membership.role !== "org_admin") {
    throw new GraphQLError("Requires org admin role", {
      extensions: { code: "FORBIDDEN" },
    });
  }
}

/** Check that user is a team admin (lead/team_admin), org admin, or global admin. */
async function requireTeamAdminOrOrgAdmin(
  prisma: Context["prisma"],
  user: { id: string; role?: string | null },
  teamId: string,
  orgId: string,
) {
  if (isPlatformAdmin(user)) return;

  // Check team admin.
  const teamMembership = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId: user.id } },
  });
  if (teamMembership && TEAM_ADMIN_ROLES.has(teamMembership.role)) return;

  // Check org admin
  const orgMembership = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId: orgId },
    },
  });
  if (orgMembership && orgMembership.role === "org_admin") return;

  throw new GraphQLError("Requires team admin or org admin role", {
    extensions: { code: "FORBIDDEN" },
  });
}
