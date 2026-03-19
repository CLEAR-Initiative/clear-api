import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

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

      if (user.role === "admin") return team;

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

      await requireTeamLeadOrOrgAdmin(
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

      await requireTeamLeadOrOrgAdmin(
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

      return context.prisma.teamMembers.create({
        data: {
          teamId: args.teamId,
          userId: args.userId,
          role: args.role ?? "viewer",
        },
      });
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

      await requireTeamLeadOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      await context.prisma.teamMembers.delete({
        where: {
          teamId_userId: { teamId: args.teamId, userId: args.userId },
        },
      });
      return true;
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

      await requireTeamLeadOrOrgAdmin(
        context.prisma,
        user,
        args.teamId,
        team.organisationId,
      );

      return context.prisma.teamMembers.update({
        where: {
          teamId_userId: { teamId: args.teamId, userId: args.userId },
        },
        data: { role: args.role },
      });
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

      await requireTeamLeadOrOrgAdmin(
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

      // Verify membership
      const membership = await context.prisma.teamMembers.findUnique({
        where: {
          teamId_userId: { teamId: args.teamId, userId: user.id },
        },
      });

      if (!membership && user.role !== "admin") {
        throw new GraphQLError("Not a member of this team", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      await context.prisma.user.update({
        where: { id: user.id },
        data: { defaultTeamId: args.teamId },
      });

      return context.prisma.teams.findUnique({ where: { id: args.teamId } });
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
  if (user.role === "admin") return;

  const membership = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId: orgId },
    },
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new GraphQLError("Requires org owner or admin role", {
      extensions: { code: "FORBIDDEN" },
    });
  }
}

/** Check that user is a team lead, org admin, or global admin. */
async function requireTeamLeadOrOrgAdmin(
  prisma: Context["prisma"],
  user: { id: string; role?: string | null },
  teamId: string,
  orgId: string,
) {
  if (user.role === "admin") return;

  // Check team lead
  const teamMembership = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId: user.id } },
  });
  if (teamMembership?.role === "lead") return;

  // Check org admin
  const orgMembership = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId: orgId },
    },
  });
  if (orgMembership && ["owner", "admin"].includes(orgMembership.role)) return;

  throw new GraphQLError("Requires team lead or org admin role", {
    extensions: { code: "FORBIDDEN" },
  });
}
