import { randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import {
  organisationInvite,
  teamInviteNotification,
} from "../services/messaging/templates.js";
import { auth } from "../lib/auth.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface InviteUserInput {
  email: string;
  organisationId: string;
  teamId?: string;
  role?: string;
  teamRole?: string;
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
  if (user.role === "admin") return user;

  const membership = await context.prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: user.id, organisationId },
    },
  });

  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new GraphQLError("Requires organisation admin or owner role", {
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
        },
      });

      if (!invite) return null;

      return {
        id: invite.id,
        email: invite.email,
        organisationName: invite.organisation.name,
        teamName: invite.team?.name ?? null,
        role: invite.role,
        teamRole: invite.teamRole,
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
      const { email, organisationId, teamId, role = "member", teamRole = "viewer" } = args.input;

      // Validate org exists
      const org = await context.prisma.organisations.findUnique({
        where: { id: organisationId },
      });
      if (!org) {
        throw new GraphQLError("Organisation not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Validate team if provided
      let teamName: string | undefined;
      if (teamId) {
        const team = await context.prisma.teams.findUnique({
          where: { id: teamId },
        });
        if (!team || team.organisationId !== organisationId) {
          throw new GraphQLError("Team not found in this organisation", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        teamName = team.name;
      }

      // Check if the user is already an org member
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
          // Already an org member — if teamId provided, add directly to team
          if (teamId) {
            const existingTeamMember = await context.prisma.teamMembers.findUnique({
              where: { teamId_userId: { teamId, userId: existingUser.id } },
            });

            if (existingTeamMember) {
              throw new GraphQLError("User is already a member of this team", {
                extensions: { code: "BAD_USER_INPUT" },
              });
            }

            // Add directly to team (no invite needed)
            await context.prisma.teamMembers.create({
              data: { teamId, userId: existingUser.id, role: teamRole },
            });

            // Send notification email
            const emailProvider = await getEmailProvider();
            const content = teamInviteNotification(
              inviter.name,
              org.name,
              teamName!,
              teamRole,
              `${env.FRONTEND_URL}/dashboard`,
            );
            await emailProvider.send({
              to: email,
              subject: content.subject,
              textBody: content.textBody,
              htmlBody: content.htmlBody,
            });

            // Return a synthetic invitation record for consistency
            return context.prisma.invitations.create({
              data: {
                email,
                organisationId,
                teamId,
                role,
                teamRole,
                token: generateToken(),
                expiresAt: new Date(),
                acceptedAt: new Date(),
                invitedById: inviter.id,
              },
            });
          }

          throw new GraphQLError("User is already a member of this organisation", {
            extensions: { code: "BAD_USER_INPUT" },
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
        throw new GraphQLError("A pending invitation already exists for this email. Use resendInvite to resend.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Create invitation
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const invitation = await context.prisma.invitations.create({
        data: {
          email,
          organisationId,
          teamId: teamId ?? null,
          role,
          teamRole: teamId ? teamRole : null,
          token,
          expiresAt,
          invitedById: inviter.id,
        },
      });

      // Send invite email
      const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${token}`;
      const emailProvider = await getEmailProvider();
      const content = organisationInvite(
        inviter.name,
        org.name,
        role,
        inviteUrl,
        teamName,
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

      // Add to team if specified
      if (invitation.teamId) {
        const existingTeamMember = await context.prisma.teamMembers.findUnique({
          where: {
            teamId_userId: {
              teamId: invitation.teamId,
              userId: existingUser.id,
            },
          },
        });

        if (!existingTeamMember) {
          await context.prisma.teamMembers.create({
            data: {
              teamId: invitation.teamId,
              userId: existingUser.id,
              role: invitation.teamRole ?? "viewer",
            },
          });
        }
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
    invitedBy: (parent: { invitedById: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.invitedById } });
    },
    status: (parent: { acceptedAt: Date | null; expiresAt: Date }) => {
      return invitationStatus(parent);
    },
  },
};
