import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";
import { env } from "../utils/env.js";
import { logActivity } from "../utils/activity-log.js";
import { onDeveloperSignedUp } from "../services/signup.js";

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
    // them via /portal/admin. Approval flips the role to `member`.
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
        // Ack email, CRM prospects sync and maintainer notification —
        // all best-effort, see services/signup.ts.
        after: async (user) => {
          await onDeveloperSignedUp(user);
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
        // /portal/admin. On approval the role flips to `member`, which
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
