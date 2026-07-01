import { randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { isPlatformAdmin, requireAuth } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import {
  organisationInvite,
  teamInviteNotification,
} from "../services/messaging/templates.js";
import { auth } from "../lib/auth.js";
import { ensureDefaultTeam } from "../services/ensure-default-team.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface TeamAssignmentInput {
  teamId: string;
  teamRole: string;
}

interface InviteUserInput {
  email: string;
  organisationId: string;
  role?: string;
  /** Required, non-empty. One row per team the invitee will be added to. */
  teams: TeamAssignmentInput[];
}

interface AcceptInviteInput {
  token: string;
  name: string;
  password: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function invitationStatus(invite: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): "pending" | "accepted" | "expired" {
  if (invite.acceptedAt) return "accepted";
  if (invite.expiresAt < new Date()) return "expired";
  return "pending";
}

async function requireOrgAdmin(context: Context, organisationId: string) {
  const user = requireAuth(context);

  // Global admins bypass org-level checks
  if (isPlatformAdmin(user)) return user;

  const membership = await context.prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId },
    },
  });

  if (!membership || membership.role !== "org_admin") {
    throw new GraphQLError("Requires organisation admin role", {
      extensions: { code: "FORBIDDEN" },
    });
  }

  return user;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export const invitationResolvers = {
  Query: {
    pendingInvites: async (
      _parent: unknown,
      args: { organisationId: string },
      context: Context,
    ) => {
      await requireOrgAdmin(context, args.organisationId);
      return context.prisma.invitations.findMany({
        where: {
          organisationId: args.organisationId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    invitationByToken: async (
      _parent: unknown,
      args: { token: string },
      context: Context,
    ) => {
      const invite = await context.prisma.invitations.findUnique({
        where: { token: args.token },
        include: {
          organisation: { select: { name: true } },
          team: { select: { name: true } },
          teams: {
            include: { team: { select: { id: true, name: true } } },
          },
        },
      });

      if (!invite) return null;

      // Build the multi-team payload. Falls back to the legacy single
      // (teamId, teamRole) pair when the join is empty so old invites still
      // render correctly on the accept page.
      const teamAssignments = invite.teams.length > 0
        ? invite.teams.map((t) => ({
            teamId: t.team.id,
            teamName: t.team.name,
            teamRole: t.teamRole,
          }))
        : invite.team
          ? [{
              teamId: invite.teamId!,
              teamName: invite.team.name,
              teamRole: invite.teamRole ?? "team_member",
            }]
          : [];

      return {
        id: invite.id,
        email: invite.email,
        organisationName: invite.organisation.name,
        teamName: invite.team?.name ?? null,
        role: invite.role,
        teamRole: invite.teamRole,
        teams: teamAssignments,
        expiresAt: invite.expiresAt,
        status: invitationStatus(invite),
      };
    },
  },

  Mutation: {
    inviteUser: async (
      _parent: unknown,
      args: { input: InviteUserInput },
      context: Context,
    ) => {
      const inviter = await requireOrgAdmin(context, args.input.organisationId);
      const { email, organisationId, role = "member", teams } = args.input;

      if (!teams || teams.length === 0) {
        throw new GraphQLError("Must specify at least one team", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Validate org exists
      const org = await context.prisma.organisations.findUnique({
        where: { id: organisationId },
      });
      if (!org) {
        throw new GraphQLError("Organisation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Validate every requested team exists in this org. We dedupe teamIds
      // so the same team listed twice doesn't double-count, and so the
      // invitationTeams unique (invitationId, teamId) constraint is safe.
      const teamIds = Array.from(new Set(teams.map((t) => t.teamId)));
      const teamRecords = await context.prisma.teams.findMany({
        where: { id: { in: teamIds }, organisationId },
        select: { id: true, name: true },
      });
      if (teamRecords.length !== teamIds.length) {
        throw new GraphQLError("One or more teams not found in this organisation", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      // Build a teamId → teamRole map from the (deduped) input.
      const roleByTeam = new Map(teams.map((t) => [t.teamId, t.teamRole]));
      const teamNamesById = new Map(teamRecords.map((t) => [t.id, t.name]));

      // Check if the user already exists / is already in the org. When they
      // are, we fast-path: add them straight to any new teams without sending
      // an invitation email (they don't need to "accept" anything).
      const existingUser = await context.prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        const existingMembership = await context.prisma.organisationUsers.findUnique({
          where: {
            userId_organisationId: { userId: existingUser.id, organisationId },
          },
        });

        if (existingMembership) {
          // Already an org member — figure out which of the requested teams
          // they're not yet in, and add them directly.
          const alreadyIn = await context.prisma.teamMembers.findMany({
            where: { userId: existingUser.id, teamId: { in: teamIds } },
            select: { teamId: true },
          });
          const alreadyInSet = new Set(alreadyIn.map((m) => m.teamId));
          const toAdd = teamIds.filter((tid) => !alreadyInSet.has(tid));

          if (toAdd.length === 0) {
            throw new GraphQLError(
              "User is already a member of all requested teams",
              { extensions: { code: "BAD_USER_INPUT" } },
            );
          }

          await context.prisma.teamMembers.createMany({
            data: toAdd.map((tid) => ({
              teamId: tid,
              userId: existingUser.id,
              role: roleByTeam.get(tid) ?? "team_member",
            })),
          });

          // Seed the invitee's default team if they don't yet have one.
          // Picks the first team from the (deduped) add list — deterministic
          // for the common single-team case, and the caller's intent for
          // the ordering-matters multi-team case.
          await ensureDefaultTeam(context.prisma, existingUser.id, toAdd[0]!);

          // Best-effort notification — failures shouldn't block the add.
          // Single email summarising the new teams the user has access to.
          try {
            const emailProvider = await getEmailProvider();
            const teamSummary = toAdd
              .map((tid) => `${teamNamesById.get(tid)} (${roleByTeam.get(tid)})`)
              .join(", ");
            const content = teamInviteNotification(
              inviter.name,
              org.name,
              teamSummary,
              roleByTeam.get(toAdd[0]!) ?? "team_member",
              `${env.FRONTEND_URL}/dashboard`,
            );
            await emailProvider.send({
              to: email,
              subject: content.subject,
              textBody: content.textBody,
              htmlBody: content.htmlBody,
            });
          } catch (err) {
            console.error("[inviteUser] team-add notification failed:", err);
          }

          // Return a synthetic accepted invitation record for caller consistency.
          return context.prisma.invitations.create({
            data: {
              email,
              organisationId,
              role,
              token: generateToken(),
              expiresAt: new Date(),
              acceptedAt: new Date(),
              invitedById: inviter.id,
              teams: {
                create: toAdd.map((tid) => ({
                  teamId: tid,
                  teamRole: roleByTeam.get(tid) ?? "team_member",
                })),
              },
            },
          });
        }
      }

      // Check for existing pending invite
      const existingInvite = await context.prisma.invitations.findFirst({
        where: {
          email,
          organisationId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (existingInvite) {
        throw new GraphQLError(
          "A pending invitation already exists for this email. Use resendInvite to resend.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      // Create invitation + the per-team rows in one query.
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const invitation = await context.prisma.invitations.create({
        data: {
          email,
          organisationId,
          role,
          token,
          expiresAt,
          invitedById: inviter.id,
          teams: {
            create: teamIds.map((tid) => ({
              teamId: tid,
              teamRole: roleByTeam.get(tid) ?? "team_member",
            })),
          },
        },
      });

      // Send invite email — list every team for context.
      const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${token}`;
      const teamSummary = teamIds
        .map((tid) => `${teamNamesById.get(tid)} (${roleByTeam.get(tid)})`)
        .join(", ");
      const emailProvider = await getEmailProvider();
      const content = organisationInvite(
        inviter.name,
        org.name,
        role,
        inviteUrl,
        teamSummary,
      );
      await emailProvider.send({
        to: email,
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });

      return invitation;
    },

    acceptInvite: async (
      _parent: unknown,
      args: { input: AcceptInviteInput },
      context: Context,
    ) => {
      const { token, name, password } = args.input;

      const invitation = await context.prisma.invitations.findUnique({
        where: { token },
      });

      if (!invitation) {
        throw new GraphQLError("Invalid invitation token", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (invitation.acceptedAt) {
        throw new GraphQLError("Invitation has already been accepted", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      if (invitation.expiresAt < new Date()) {
        throw new GraphQLError("Invitation has expired", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Check if user with this email already exists
      let existingUser = await context.prisma.user.findUnique({
        where: { email: invitation.email },
      });

      if (!existingUser) {
        // Create new user via Better Auth
        const signup = await auth.api.signUpEmail({
          body: { name, email: invitation.email, password },
        });
        // Mark email as verified (admin vouched for it)
        await context.prisma.user.update({
          where: { id: signup.user.id },
          data: { emailVerified: true },
        });
        existingUser = await context.prisma.user.findUniqueOrThrow({
          where: { id: signup.user.id },
        });
      }

      // Add to organisation
      const existingOrgMembership = await context.prisma.organisationUsers.findUnique({
        where: {
          userId_organisationId: {
            userId: existingUser.id,
            organisationId: invitation.organisationId,
          },
        },
      });

      if (!existingOrgMembership) {
        await context.prisma.organisationUsers.create({
          data: {
            userId: existingUser.id,
            organisationId: invitation.organisationId,
            role: invitation.role,
          },
        });
      }

      // Add to every team listed in the invitation. Falls back to the legacy
      // single `teamId` for invitations created before the join existed.
      const invitationTeams = await context.prisma.invitationTeams.findMany({
        where: { invitationId: invitation.id },
        select: { teamId: true, teamRole: true },
      });
      const teamAssignments = invitationTeams.length > 0
        ? invitationTeams
        : invitation.teamId
          ? [{ teamId: invitation.teamId, teamRole: invitation.teamRole ?? "team_member" }]
          : [];

      for (const a of teamAssignments) {
        await context.prisma.teamMembers.upsert({
          where: { teamId_userId: { teamId: a.teamId, userId: existingUser.id } },
          create: { teamId: a.teamId, userId: existingUser.id, role: a.teamRole },
          update: {},
        });
      }

      // Seed defaultTeamId if unset. Uses the invitation's first team
      // assignment — this is the invitee's initial team and the sensible
      // pick for a "which team am I filing under by default" hint.
      if (teamAssignments.length > 0) {
        await ensureDefaultTeam(
          context.prisma, existingUser.id, teamAssignments[0]!.teamId,
        );
      }

      // Mark invitation as accepted
      await context.prisma.invitations.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      return true;
    },

    cancelInvite: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const invitation = await context.prisma.invitations.findUnique({
        where: { id: args.id },
      });

      if (!invitation) {
        throw new GraphQLError("Invitation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await requireOrgAdmin(context, invitation.organisationId);

      await context.prisma.invitations.delete({
        where: { id: args.id },
      });

      return true;
    },

    resendInvite: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const invitation = await context.prisma.invitations.findUnique({
        where: { id: args.id },
        include: {
          organisation: { select: { name: true } },
          team: { select: { name: true } },
        },
      });

      if (!invitation) {
        throw new GraphQLError("Invitation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const inviter = await requireOrgAdmin(context, invitation.organisationId);

      if (invitation.acceptedAt) {
        throw new GraphQLError("Cannot resend an accepted invitation", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Reset token and expiry
      const newToken = generateToken();
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const updated = await context.prisma.invitations.update({
        where: { id: args.id },
        data: { token: newToken, expiresAt: newExpiry },
      });

      // Resend email
      const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${newToken}`;
      const emailProvider = await getEmailProvider();
      const content = organisationInvite(
        inviter.name,
        invitation.organisation.name,
        invitation.role,
        inviteUrl,
        invitation.team?.name,
      );
      await emailProvider.send({
        to: invitation.email,
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });

      return updated;
    },
  },

  Invitation: {
    organisation: (parent: { organisationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.organisations.findUnique({ where: { id: parent.organisationId } });
    },
    team: (parent: { teamId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.teamId) return null;
      return prisma.teams.findUnique({ where: { id: parent.teamId } });
    },
    teams: async (parent: { id: string; teamId: string | null; teamRole: string | null }, _args: unknown, { prisma }: Context) => {
      const rows = await prisma.invitationTeams.findMany({
        where: { invitationId: parent.id },
        include: { team: true },
      });
      if (rows.length > 0) {
        return rows.map((r) => ({ team: r.team, teamRole: r.teamRole }));
      }
      // Legacy fallback for pre-join-table invitations.
      if (parent.teamId) {
        const team = await prisma.teams.findUnique({ where: { id: parent.teamId } });
        if (team) return [{ team, teamRole: parent.teamRole ?? "team_member" }];
      }
      return [];
    },
    invitedBy: (parent: { invitedById: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.invitedById } });
    },
    status: (parent: { acceptedAt: Date | null; expiresAt: Date }) => {
      return invitationStatus(parent);
    },
  },

  InvitationTeam: {
    // `team` and `teamRole` are returned directly by the parent resolver above.
  },
};
