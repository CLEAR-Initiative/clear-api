import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";

/**
 * Admin management of the per-user Signal source whitelist.
 *
 * An API-only developer reads no Signals until an admin opens specific data
 * sources here. Enforcement lives in `utils/signal-access.ts`; this file is
 * only the configuration surface.
 */
export const apiSignalSourceGrantResolvers = {
  Query: {
    apiSignalSourceGrants: async (
      _parent: unknown,
      args: { userId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return context.prisma.apiSignalSourceGrant.findMany({
        where: { userId: args.userId },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    grantApiSignalSource: async (
      _parent: unknown,
      args: { userId: string; dataSourceId: string; reason?: string | null },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);

      // Fail loudly on a bad id rather than writing a grant that can never
      // match a Signal.
      const [user, source] = await Promise.all([
        context.prisma.user.findUnique({ where: { id: args.userId }, select: { id: true } }),
        context.prisma.dataSources.findUnique({
          where: { id: args.dataSourceId },
          select: { id: true, name: true },
        }),
      ]);
      if (!user) {
        throw new GraphQLError("User not found", { extensions: { code: "NOT_FOUND" } });
      }
      if (!source) {
        throw new GraphQLError("Data source not found", { extensions: { code: "NOT_FOUND" } });
      }

      // Idempotent: re-granting is a no-op that returns the existing row, so a
      // retried admin action never errors.
      const grant = await context.prisma.apiSignalSourceGrant.upsert({
        where: { userId_dataSourceId: { userId: args.userId, dataSourceId: args.dataSourceId } },
        create: {
          userId: args.userId,
          dataSourceId: args.dataSourceId,
          grantedById: admin.id,
          reason: args.reason?.trim() || null,
        },
        update: {},
      });

      // activity_logs.userId is NOT NULL and means "who acted", so the admin
      // is the actor and the developer is the resource.
      void logActivity(context.prisma, {
        userId: admin.id,
        action: "api_signal_source.grant",
        resourceType: "user",
        resourceId: args.userId,
        metadata: {
          dataSourceId: args.dataSourceId,
          dataSourceName: source.name,
          reason: grant.reason,
        },
      });
      return grant;
    },

    revokeApiSignalSource: async (
      _parent: unknown,
      args: { userId: string; dataSourceId: string },
      context: Context,
    ) => {
      const admin = requireRole(context, ["admin"]);
      const { count } = await context.prisma.apiSignalSourceGrant.deleteMany({
        where: { userId: args.userId, dataSourceId: args.dataSourceId },
      });
      if (count > 0) {
        void logActivity(context.prisma, {
          userId: admin.id,
          action: "api_signal_source.revoke",
          resourceType: "user",
          resourceId: args.userId,
          metadata: { dataSourceId: args.dataSourceId },
        });
      }
      return count > 0;
    },
  },

  ApiSignalSourceGrant: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) =>
      prisma.user.findUnique({ where: { id: parent.userId } }),
    dataSource: (parent: { dataSourceId: string }, _args: unknown, { prisma }: Context) =>
      prisma.dataSources.findUnique({ where: { id: parent.dataSourceId } }),
    grantedBy: (parent: { grantedById: string | null }, _args: unknown, { prisma }: Context) =>
      parent.grantedById ? prisma.user.findUnique({ where: { id: parent.grantedById } }) : null,
  },
};
