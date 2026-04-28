import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface CreateOrganisationInput {
  name: string;
  slug: string;
}

interface UpdateOrganisationInput {
  name?: string;
  slug?: string;
  isActive?: boolean;
}

export const organisationResolvers = {
  Query: {
    myOrganisations: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      const user = requireAuth(context);

      // Global admins see all organisations
      if (user.role === "admin") {
        return context.prisma.organisations.findMany({
          orderBy: { createdAt: "desc" },
        });
      }

      const memberships = await context.prisma.organisationUsers.findMany({
        where: { userId: user.id },
        select: { organisationId: true },
      });
      return context.prisma.organisations.findMany({
        where: { id: { in: memberships.map((m) => m.organisationId) } },
      });
    },

    organisation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const org = await context.prisma.organisations.findUnique({
        where: { id: args.id },
      });
      if (!org) return null;

      // Global admins can see any org
      if (user.role === "admin") return org;

      // Otherwise must be a member
      const membership = await context.prisma.organisationUsers.findUnique({
        where: {
          userId_organisationId: {
            userId: user.id,
            organisationId: args.id,
          },
        },
      });
      if (!membership) {
        throw new GraphQLError("Not a member of this organisation", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      return org;
    },
  },

  Mutation: {
    createOrganisation: async (
      _parent: unknown,
      args: { input: CreateOrganisationInput },
      context: Context,
    ) => {
      // Only global admins can create organisations
      requireRole(context, ["admin"]);
      const { name, slug } = args.input;

      const existing = await context.prisma.organisations.findUnique({
        where: { slug },
      });
      if (existing) {
        throw new GraphQLError("An organisation with this slug already exists", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Create the org and a same-named default team in a single transaction
      // so an org can never exist without its default team. Subsequent invites
      // / addOrgMember calls auto-route members into this team while it's the
      // only one in the org.
      return context.prisma.$transaction(async (tx) => {
        const org = await tx.organisations.create({ data: { name, slug } });
        await tx.teams.create({
          data: {
            organisationId: org.id,
            name,
            slug,
            description: "Default team — created automatically with the organisation.",
          },
        });
        return org;
      });
    },

    deleteOrganisation: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      // Only global admins can delete organisations
      requireRole(context, ["admin"]);

      const org = await context.prisma.organisations.findUnique({
        where: { id: args.id },
      });
      if (!org) {
        throw new GraphQLError("Organisation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Cascade is handled by Prisma schema (onDelete: Cascade on teams, members, invitations)
      await context.prisma.organisations.delete({ where: { id: args.id } });
      return true;
    },

    updateOrganisation: async (
      _parent: unknown,
      args: { id: string; input: UpdateOrganisationInput },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const org = await context.prisma.organisations.findUnique({
        where: { id: args.id },
      });
      if (!org) {
        throw new GraphQLError("Organisation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireOrgAdmin(context.prisma, user, args.id);

      return context.prisma.organisations.update({
        where: { id: args.id },
        data: args.input,
      });
    },

    addOrgMember: async (
      _parent: unknown,
      args: { orgId: string; userId: string; role?: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      await requireOrgAdmin(context.prisma, user, args.orgId);

      let targetUserId = args.userId;
      if (args.userId.includes("@")) {
        const found = await context.prisma.user.findFirst({
          where: { email: args.userId },
        });
        if (!found) {
          throw new GraphQLError("No user found with that email address", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        targetUserId = found.id;
      }

      // Org membership + auto-route into the default team run in one
      // transaction so we never end up with an org member who silently failed
      // to land in the only team (and vice versa).
      return context.prisma.$transaction(async (tx) => {
        const membership = await tx.organisationUsers.create({
          data: {
            userId: targetUserId,
            organisationId: args.orgId,
            role: args.role ?? "member",
          },
        });

        // Auto-route into the org's only team while the org has just one team
        // — usually the default team created with the org. Invitations carry
        // their own team list and bypass this path.
        const teams = await tx.teams.findMany({
          where: { organisationId: args.orgId },
          select: { id: true },
          take: 2,
        });
        if (teams.length === 1) {
          await tx.teamMembers.upsert({
            where: { teamId_userId: { teamId: teams[0]!.id, userId: targetUserId } },
            create: { teamId: teams[0]!.id, userId: targetUserId, role: "viewer" },
            update: {},
          });
        }

        return membership;
      });
    },

    removeOrgMember: async (
      _parent: unknown,
      args: { orgId: string; userId: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      await requireOrgAdmin(context.prisma, user, args.orgId);

      try {
        await context.prisma.organisationUsers.delete({
          where: {
            userId_organisationId: {
              userId: args.userId,
              organisationId: args.orgId,
            },
          },
        });
        return true;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "P2025"
        ) {
          return false;
        }
        throw error;
      }
    },
  },

  Organisation: {
    teams: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.teams.findMany({
        where: { organisationId: parent.id },
      });
    },
    members: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.organisationUsers.findMany({
        where: { organisationId: parent.id },
      });
    },
  },

  OrgMember: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
};

/** Helper: check that the user is an org owner/admin, or a global admin. */
async function requireOrgAdmin(
  prisma: Context["prisma"],
  user: { id: string; role?: string | null },
  orgId: string,
) {
  if (user.role === "admin") return; // global admin bypass

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
