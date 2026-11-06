import { GraphQLError } from "graphql";
import { randomBytes } from "crypto";
import type { Context } from "../context.js";
import { requireNonWorker } from "../utils/auth-guard.js";
import { getEmailProvider, templates } from "../services/messaging/index.js";
import {
  MIN_PASSWORD_LENGTH,
  buildAppResetUrl,
  resetPasswordWithToken,
  sendPasswordResetEmail,
} from "../services/password-reset.js";
import {
  brandedUrl,
  resolveSender,
  safeFrontendBase,
  trustedFrontendBase,
  type TouchpointParams,
} from "../services/branding.js";

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
      args: TouchpointParams,
      context: Context,
    ) => {
      const user = requireNonWorker(context);

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

      // Build verification URL and send email. Authenticated caller → trust
      // the supplied frontend base as-is (falls back to FRONTEND_URL).
      const base = trustedFrontendBase(args.frontendBaseUrl);
      const sender = resolveSender(args);
      const verificationUrl = brandedUrl(base, `/verify-email/${token}`);
      const email = templates.emailVerification(user.name, verificationUrl);

      try {
        const provider = await getEmailProvider();
        await provider.send({
          to: user.email,
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
          replyTo: sender.replyTo,
          fromName: sender.fromName,
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
      args: { email: string } & TouchpointParams,
      context: Context,
    ) => {
      // Always resolves true regardless of whether the address exists,
      // is throttled, or the mail send failed — see
      // `sendPasswordResetEmail`. Never branch on the return value here
      // or the enumeration guarantee is lost. The CLEAR app calls this, so
      // the link lands on the app's reset page, not the Developer Portal.
      //
      // UNAUTHENTICATED: the frontend base is allowlist-gated so a caller
      // cannot point the emailed reset link (which carries the token) at an
      // arbitrary host. An un-allowlisted override silently falls back to
      // FRONTEND_URL.
      const base = safeFrontendBase(args.frontendBaseUrl);
      const sender = resolveSender(args);
      await sendPasswordResetEmail(
        context.prisma,
        args.email,
        (token) => buildAppResetUrl(token, base),
        sender,
      );
      return true;
    },

    resetPassword: async (
      _parent: unknown,
      args: { token: string; newPassword: string },
      context: Context,
    ) => {
      const result = await resetPasswordWithToken(
        context.prisma,
        args.token,
        args.newPassword,
      );
      if (result.ok) return true;

      switch (result.reason) {
        case "WEAK_PASSWORD":
          throw new GraphQLError(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        case "INVALID_TOKEN":
          throw new GraphQLError("Invalid or expired reset token", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        case "USER_NOT_FOUND":
          throw new GraphQLError("User not found", {
            extensions: { code: "NOT_FOUND" },
          });
      }
    },
  },
};
