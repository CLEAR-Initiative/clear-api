import { GraphQLError } from "graphql";
import { randomBytes } from "crypto";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";
import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "../services/messaging/index.js";

const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes between verification requests

export const authResolvers = {
  Query: {
    me: (_parent: unknown, _args: unknown, { user }: Context) => {
      if (!user) return null;
      return user;
    },
  },
  Mutation: {
    requestEmailVerification: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      const user = requireAuth(context);

      if (user.emailVerified) {
        throw new GraphQLError("Email is already verified", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Throttle: check if a verification was sent recently
      const recentVerification =
        await context.prisma.verification.findFirst({
          where: { identifier: user.email },
          orderBy: { createdAt: "desc" },
        });

      if (
        recentVerification?.createdAt &&
        Date.now() - recentVerification.createdAt.getTime() < THROTTLE_MS
      ) {
        throw new GraphQLError(
          "Verification email was sent recently. Please wait 5 minutes before requesting another.",
          { extensions: { code: "RATE_LIMITED" } },
        );
      }

      // Clean up old tokens for this email
      await context.prisma.verification.deleteMany({
        where: { identifier: user.email },
      });

      // Create new token
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await context.prisma.verification.create({
        data: {
          identifier: user.email,
          value: token,
          expiresAt,
        },
      });

      // Build verification URL and send email
      const verificationUrl = `${env.FRONTEND_URL}/verify-email/${token}`;
      const email = templates.emailVerification(user.name, verificationUrl);

      try {
        const provider = await getEmailProvider();
        await provider.send({
          to: user.email,
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
        });
        console.log(
          `[AUTH] Verification email sent to ${user.email}`,
        );
      } catch (error) {
        console.error(
          `[AUTH] Failed to send verification email to ${user.email}:`,
          error instanceof Error ? error.message : error,
        );
        throw new GraphQLError(
          "Failed to send verification email. Please try again later.",
          { extensions: { code: "INTERNAL_SERVER_ERROR" } },
        );
      }

      return true;
    },

    verifyEmail: async (
      _parent: unknown,
      args: { token: string },
      context: Context,
    ) => {
      const verification = await context.prisma.verification.findFirst({
        where: {
          value: args.token,
          expiresAt: { gt: new Date() },
        },
      });

      if (!verification) {
        throw new GraphQLError("Invalid or expired verification token", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      await context.prisma.user.updateMany({
        where: { email: verification.identifier },
        data: { emailVerified: true },
      });

      await context.prisma.verification.delete({
        where: { id: verification.id },
      });

      return true;
    },

    requestPasswordReset: async (
      _parent: unknown,
      args: { email: string },
      context: Context,
    ) => {
      // Always return true to prevent email enumeration
      const user = await context.prisma.user.findUnique({
        where: { email: args.email },
      });

      if (!user) return true;

      // Throttle check
      const identifier = `password-reset:${args.email}`;
      const recent = await context.prisma.verification.findFirst({
        where: { identifier },
        orderBy: { createdAt: "desc" },
      });

      if (recent?.createdAt && Date.now() - recent.createdAt.getTime() < THROTTLE_MS) {
        // Silently succeed — don't reveal throttle to client
        return true;
      }

      // Clean up old tokens
      await context.prisma.verification.deleteMany({ where: { identifier } });

      // Create reset token (1 hour expiry)
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await context.prisma.verification.create({
        data: { identifier, value: token, expiresAt },
      });

      // Send password reset email
      const resetUrl = `${env.FRONTEND_URL}/auth/reset-password?token=${token}`;
      const emailContent = templates.passwordReset(user.name, resetUrl);

      try {
        const provider = await getEmailProvider();
        await provider.send({
          to: args.email,
          subject: emailContent.subject,
          textBody: emailContent.textBody,
          htmlBody: emailContent.htmlBody,
        });
      } catch (error) {
        console.error("[AUTH] Failed to send password reset email:", error instanceof Error ? error.message : error);
        // Don't throw — silently fail to prevent info leakage
      }

      return true;
    },

    resetPassword: async (
      _parent: unknown,
      args: { token: string; newPassword: string },
      context: Context,
    ) => {
      if (args.newPassword.length < 8) {
        throw new GraphQLError("Password must be at least 8 characters", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const verification = await context.prisma.verification.findFirst({
        where: {
          value: args.token,
          identifier: { startsWith: "password-reset:" },
          expiresAt: { gt: new Date() },
        },
      });

      if (!verification) {
        throw new GraphQLError("Invalid or expired reset token", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const email = verification.identifier.replace("password-reset:", "");
      const user = await context.prisma.user.findUnique({ where: { email } });

      if (!user) {
        throw new GraphQLError("User not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Hash new password using Better Auth's built-in hasher
      const { hashPassword } = await import("better-auth/crypto");
      const hashedPassword = await hashPassword(args.newPassword);

      await context.prisma.account.updateMany({
        where: { userId: user.id, providerId: "credential" },
        data: { password: hashedPassword },
      });

      // Clean up verification token
      await context.prisma.verification.delete({
        where: { id: verification.id },
      });

      return true;
    },
  },
};
