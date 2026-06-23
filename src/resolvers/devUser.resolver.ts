import { randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import { generateApiKey } from "../utils/api-key.js";
import { logActivity } from "../utils/activity-log.js";
import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "../services/messaging/index.js";

interface CreateDevUserInput {
  email: string;
  name: string;
  keyName?: string;
}

// 7 days. Welcome emails may sit unread for a while; the short forgot-
// password TTL (1 hour) is not appropriate here. Identifier prefix
// matches the existing resetPassword mutation so the same resolver can
// consume the token.
const SET_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SET_PASSWORD_IDENTIFIER_PREFIX = "password-reset:";

// Match the cap on the user-side createApiKey mutation.
const MAX_ACTIVE_KEYS_PER_USER = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Issue a long-lived set-password token for the given email and return the
 * user-facing URL. Stored in the same `verification` table the existing
 * `requestPasswordReset` / `resetPassword` mutations use, so the existing
 * `/auth/reset-password` page can consume it without changes.
 */
async function issueSetPasswordUrl(
  prisma: Context["prisma"],
  email: string,
): Promise<string> {
  const identifier = `${SET_PASSWORD_IDENTIFIER_PREFIX}${email}`;
  // Clear any older outstanding tokens for the same email so the welcome
  // email's link is the only one that works. Idempotent if there are
  // none.
  await prisma.verification.deleteMany({ where: { identifier } });

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SET_PASSWORD_TTL_MS);
  await prisma.verification.create({
    data: { identifier, value: token, expiresAt },
  });

  // The reset-password page already supports the same token shape. The
  // `kind=setup` query flag lets it swap the headline copy to "Welcome to
  // CLEAR — choose a password" for a less jarring first impression; if
  // the page ignores it the flow still works.
  return `${env.FRONTEND_URL}/auth/reset-password?token=${token}&kind=setup`;
}

export const devUserResolvers = {
  Mutation: {
    createDevUser: async (
      _parent: unknown,
      args: { input: CreateDevUserInput },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);
      const { name, keyName } = args.input;

      const email = normaliseEmail(args.input.email);
      if (!EMAIL_RE.test(email)) {
        throw new GraphQLError("Email is not a valid address", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      if (!name.trim()) {
        throw new GraphQLError("Name is required", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Dedup by email. `email` is unique on the user row so collisions
      // would surface as Prisma errors anyway — this check just gives the
      // caller a typed BAD_USER_INPUT instead of a raw P2002. CRM-side
      // dedup happens in the queue: once the contact is tagged
      // `clear_approved` it falls out of the waitlist and admins cannot
      // re-approve the same applicant.
      const existingByEmail = await context.prisma.user.findUnique({
        where: { email },
      });
      if (existingByEmail) {
        throw new GraphQLError("A user with that email already exists", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const { plaintextKey, prefix, keyHash } = generateApiKey();

      // Transactional core: user + apiKey row in one shot. If either
      // fails the whole thing rolls back so we don't end up with an
      // orphaned user that has no key (or a key whose user vanished).
      // The welcome email and the set-password token are issued AFTER
      // commit so an email-provider hiccup doesn't roll back the
      // provisioning — the admin can resend separately.
      const { user } = await context.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            name,
            // Admin is vouching for the address; skip the verify-your-
            // email wall for the website login flow.
            emailVerified: true,
            isActive: true,
            role: "viewer",
          },
        });
        await tx.apiKeys.create({
          data: {
            userId: newUser.id,
            name: keyName?.trim() || "Initial dev key",
            prefix,
            keyHash,
            // Indefinite per current product decision. Admins can revoke
            // or rotate via the existing mutations.
            expiresAt: null,
          },
        });
        return { user: newUser };
      });

      // Best-effort tail. Each step logs on failure and surfaces its
      // outcome on the result so the admin UI can show a per-step status
      // and offer a retry.
      let setPasswordTokenIssued = false;
      let setPasswordUrl = "";
      try {
        setPasswordUrl = await issueSetPasswordUrl(context.prisma, email);
        setPasswordTokenIssued = true;
      } catch (err) {
        console.error(
          "[CREATE_DEV_USER] Failed to issue set-password token:",
          err instanceof Error ? err.message : err,
        );
      }

      let welcomeEmailSent = false;
      try {
        const emailContent = templates.welcomeDevUser(
          name,
          plaintextKey,
          setPasswordUrl,
          Math.round(SET_PASSWORD_TTL_MS / (24 * 60 * 60 * 1000)),
          `${env.FRONTEND_URL.replace(/\/$/, "")}/graphql`,
          `${env.FRONTEND_URL.replace(/\/$/, "")}/docs`,
        );
        const provider = await getEmailProvider();
        await provider.send({
          to: email,
          subject: emailContent.subject,
          textBody: emailContent.textBody,
          htmlBody: emailContent.htmlBody,
        });
        welcomeEmailSent = true;
      } catch (err) {
        console.error(
          "[CREATE_DEV_USER] Failed to send welcome email:",
          err instanceof Error ? err.message : err,
        );
      }

      // Audit. Never includes the plaintext key.
      await logActivity(context.prisma, {
        userId: admin.id,
        action: "dev_user.provisioned",
        resourceType: "user",
        resourceId: user.id,
        metadata: {
          email,
          welcomeEmailSent,
          setPasswordTokenIssued,
        },
      });

      return {
        user,
        plaintextKey,
        welcomeEmailSent,
        setPasswordTokenIssued,
      };
    },

    rotateDevUserApiKey: async (
      _parent: unknown,
      args: { userId: string },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);

      const user = await context.prisma.user.findUnique({
        where: { id: args.userId },
      });
      if (!user) {
        throw new GraphQLError("User not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Revoke every active key. Done as updateMany so concurrent rotations
      // converge instead of racing.
      await context.prisma.apiKeys.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Cap remains enforced — if the user already has 10 revoked keys
      // we still mint, but if they somehow have 10 active ones (shouldn't
      // happen since we just revoked) the cap check protects us.
      const activeCount = await context.prisma.apiKeys.count({
        where: { userId: user.id, revokedAt: null },
      });
      if (activeCount >= MAX_ACTIVE_KEYS_PER_USER) {
        throw new GraphQLError(
          "Maximum active API keys per user reached after rotation",
          { extensions: { code: "INTERNAL_SERVER_ERROR" } },
        );
      }

      const { plaintextKey, prefix, keyHash } = generateApiKey();
      await context.prisma.apiKeys.create({
        data: {
          userId: user.id,
          name: "Rotated dev key",
          prefix,
          keyHash,
          expiresAt: null,
        },
      });

      // Best-effort rotation email. Reuses the welcome template — the
      // copy is identical from the dev's perspective ("here's your new
      // key, save it now"). If we want a separate "your key was rotated"
      // template we can split later.
      let notificationEmailSent = false;
      try {
        const emailContent = templates.welcomeDevUser(
          user.name,
          plaintextKey,
          // Rotation doesn't reissue the set-password token; pass an
          // empty string and the template will still render — the dev
          // already has (or doesn't have) a password from earlier.
          "",
          Math.round(SET_PASSWORD_TTL_MS / (24 * 60 * 60 * 1000)),
          `${env.FRONTEND_URL.replace(/\/$/, "")}/graphql`,
          `${env.FRONTEND_URL.replace(/\/$/, "")}/docs`,
        );
        const provider = await getEmailProvider();
        await provider.send({
          to: user.email,
          subject: "Your CLEAR API key has been rotated",
          textBody: emailContent.textBody,
          htmlBody: emailContent.htmlBody,
        });
        notificationEmailSent = true;
      } catch (err) {
        console.error(
          "[ROTATE_DEV_USER_API_KEY] Failed to send rotation email:",
          err instanceof Error ? err.message : err,
        );
      }

      await logActivity(context.prisma, {
        userId: admin.id,
        action: "dev_user.api_key_rotated",
        resourceType: "user",
        resourceId: user.id,
        metadata: { notificationEmailSent },
      });

      return {
        user,
        plaintextKey,
        notificationEmailSent,
      };
    },
  },
};
