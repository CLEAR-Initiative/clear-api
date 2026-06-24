import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";
import { env } from "../utils/env.js";
import { logActivity } from "../utils/activity-log.js";
import { pushToProspects } from "../services/exponential.js";

/**
 * Split a Better Auth display name into first / last so the CRM contact
 * row gets populated as expected. Best-effort — accounts created with a
 * single-word name land it in `firstName` with `lastName` left null.
 */
function splitName(name: string | null | undefined): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  if (!name) return { firstName: undefined, lastName: undefined };
  const trimmed = name.trim();
  if (!trimmed) return { firstName: undefined, lastName: undefined };
  const space = trimmed.indexOf(" ");
  if (space === -1) return { firstName: trimmed, lastName: undefined };
  return {
    firstName: trimmed.slice(0, space),
    lastName: trimmed.slice(space + 1).trim() || undefined,
  };
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    // Self-signup is open. New accounts land with `role = "pending"`
    // (see `user.additionalFields.role` below) and are gated out of
    // every content and sensitive-data resolver until an admin approves
    // them via /portal/admin. Approval flips the role to `viewer`.
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh after 1 day
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min cache to reduce DB hits
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Fires immediately after Better Auth inserts a new user row,
        // i.e. on successful self-signup via /api/auth/sign-up/email.
        // We push the new user into the Exponential prospects
        // collection so the onboarding "acknowledgement" automation
        // fires. Best-effort: if Exponential is unreachable or the env
        // vars aren't set, the signup still succeeds — the admin can
        // resync from /portal/admin later.
        after: async (user) => {
          const { firstName, lastName } = splitName(user.name);
          const result = await pushToProspects({
            email: user.email,
            firstName,
            lastName,
          });
          if (!result.ok) {
            console.error(
              `[auth.signup] CRM prospects sync failed for ${user.email}: ${result.reason}`,
            );
          }
        },
      },
    },
    session: {
      create: {
        // Fires after Better Auth inserts a new session row - the cleanest
        // signal of a successful login. We capture the session's ip and
        // user-agent here because the resolver-layer activity log doesn't
        // see request headers.
        after: async (session) => {
          await logActivity(prisma, {
            userId: session.userId,
            action: "auth.login",
            resourceType: "session",
            resourceId: session.id,
            ipAddress: session.ipAddress ?? null,
            userAgent: session.userAgent ?? null,
          });
        },
      },
      // We don't hook delete: sessions expire naturally and the only
      // explicit deletion is /api/auth/sign-out, which is logged via the
      // resolver flow when applicable.
    },
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        // New signups land as `pending` and are gated out of all
        // content + sensitive data until an admin approves them via
        // /portal/admin. On approval the role flips to `viewer`, which
        // grants read access to signals/events/alerts/crises only.
        defaultValue: "pending",
        input: false,
      },
      isActive: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
      defaultTeamId: {
        type: "string",
        required: false,
        input: false,
      },
      language: {
        type: "string",
        required: false,
        defaultValue: "en",
        input: false,
      },
    },
  },
  trustedOrigins: env.CORS_ORIGINS,
});

export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;
