import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

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
      const user = requireAuth(context);
      const { name, slug } = args.input;

      const existing = await context.prisma.organisations.findUnique({
        where: { slug },
      });
      if (existing) {
        throw new GraphQLError("An organisation with this slug already exists", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      return context.prisma.organisations.create({
        data: {
          name,
          slug,
          users: {
            create: {
              userId: user.id,
              role: "owner",
            },
          },
        },
      });
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

      return context.prisma.organisationUsers.create({
        data: {
          userId: targetUserId,
          organisationId: args.orgId,
          role: args.role ?? "member",
        },
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
