import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { isPlatformAdmin, requireAuth, requireRole } from "../utils/auth-guard.js";
import { removeOrgMember as removeOrgMemberService } from "../services/team-membership.js";

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
      if (isPlatformAdmin(user)) {
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
      if (isPlatformAdmin(user)) return org;

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
      // The schema doc for this mutation states the creator becomes
      // the first org_admin. Bind the authenticated user here so we
      // can insert the organisationUsers row in the same transaction.
      const creator = requireAuth(context);
      const { name, slug } = args.input;

      const existing = await context.prisma.organisations.findUnique({
        where: { slug },
      });
      if (existing) {
        throw new GraphQLError("An organisation with this slug already exists", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Create the org + default team + creator's org_admin +
      // creator's team_admin membership in one transaction. The
      // organisationUsers row satisfies the schema-doc claim; the
      // teamMembers row honours the "no org member without a team"
      // invariant enforced by src/services/team-membership.ts.
      return context.prisma.$transaction(async (tx) => {
        const org = await tx.organisations.create({ data: { name, slug } });
        const defaultTeam = await tx.teams.create({
          data: {
            organisationId: org.id,
            name,
            slug,
            description: "Default team — created automatically with the organisation.",
          },
        });
        await tx.organisationUsers.create({
          data: {
            organisationId: org.id,
            userId: creator.id,
            role: "org_admin",
          },
        });
        await tx.teamMembers.create({
          data: {
            teamId: defaultTeam.id,
            userId: creator.id,
            role: "team_admin",
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
        // First-member default: when no role was passed AND the org
        // currently has zero members, promote to org_admin so the org
        // isn't left without an administrator. Explicitly-passed roles
        // are always respected. Matches the SuperAdmin portal's
        // `defaultOrgRoleForNewMember(memberCount)` heuristic.
        let role = args.role ?? null;
        if (role === null) {
          const existingCount = await tx.organisationUsers.count({
            where: { organisationId: args.orgId },
          });
          role = existingCount === 0 ? "org_admin" : "member";
        }
        const membership = await tx.organisationUsers.create({
          data: {
            userId: targetUserId,
            organisationId: args.orgId,
            role,
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
            create: { teamId: teams[0]!.id, userId: targetUserId, role: "team_member" },
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

      // Delegate to the shared service — it also cascades team
      // memberships within this org, keeping the "no team member
      // without an org row" invariant. See
      // src/services/team-membership.ts.
      const result = await removeOrgMemberService(context.prisma, {
        organisationId: args.orgId,
        userId: args.userId,
      });
      return result.removed;
    },

    /**
     * Change an existing member's role within an organisation.
     * The GraphQL enum bounds the role value to `org_admin | member`, but
     * we still guard defensively here so a caller who slips a bad string
     * past a stale client gets a clear rejection rather than a silent DB
     * write of a non-taxonomy value.
     */
    updateOrgMemberRole: async (
      _parent: unknown,
      args: { orgId: string; userId: string; role: string },
      context: Context,
    ) => {
      const user = requireAuth(context);
      await requireOrgAdmin(context.prisma, user, args.orgId);

      if (!["org_admin", "member"].includes(args.role)) {
        throw new GraphQLError(
          `Invalid org role "${args.role}". Must be one of: org_admin, member`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      try {
        return await context.prisma.organisationUsers.update({
          where: {
            userId_organisationId: {
              userId: args.userId,
              organisationId: args.orgId,
            },
          },
          data: { role: args.role },
        });
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "P2025"
        ) {
          throw new GraphQLError("Member not found in this organisation", {
            extensions: { code: "NOT_FOUND" },
          });
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
  if (isPlatformAdmin(user)) return; // global admin bypass

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
