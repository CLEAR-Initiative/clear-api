import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";
import { env } from "../utils/env.js";
import { logActivity } from "../utils/activity-log.js";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
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
    session: {
      create: {
        // Fires after Better Auth inserts a new session row — the cleanest
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
        defaultValue: "viewer",
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
    },
  },
  trustedOrigins: env.CORS_ORIGINS,
});

export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;
