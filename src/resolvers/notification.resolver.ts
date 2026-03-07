import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { NotificationStatus } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface CreateNotificationInput {
  userId: string;
  message: string;
  notificationType: string;
  actionUrl?: string;
  actionText?: string;
}

export const notificationResolvers = {
  Query: {
    notifications: (
      _parent: unknown,
      args: { status?: NotificationStatus },
      context: Context,
    ) => {
      const user = requireAuth(context);
      return context.prisma.notifications.findMany({
        where: {
          userId: user.id,
          ...(args.status ? { status: args.status } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
    },
    notification: (_parent: unknown, args: { id: string }, context: Context) => {
      const user = requireAuth(context);
      return context.prisma.notifications.findFirst({
        where: { id: args.id, userId: user.id },
      });
    },
  },
  Mutation: {
    createNotification: async (
      _parent: unknown,
      args: { input: CreateNotificationInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      return context.prisma.notifications.create({
        data: {
          userId: input.userId,
          message: input.message,
          notificationType: input.notificationType,
          actionUrl: input.actionUrl,
          actionText: input.actionText,
        },
      });
    },

    deleteNotification: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const notification = await context.prisma.notifications.findUnique({
        where: { id: args.id },
      });

      if (!notification || notification.userId !== user.id) {
        throw new GraphQLError("Notification not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.notifications.delete({ where: { id: args.id } });
      return true;
    },

    markNotificationRead: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const notification = await context.prisma.notifications.findUnique({
        where: { id: args.id },
      });

      if (!notification || notification.userId !== user.id) {
        throw new GraphQLError("Notification not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.notifications.update({
        where: { id: args.id },
        data: { status: "READ" },
      });
    },
    markAllNotificationsRead: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ) => {
      const user = requireAuth(context);

      await context.prisma.notifications.updateMany({
        where: { userId: user.id, status: { not: "READ" } },
        data: { status: "READ" },
      });

      return true;
    },
  },
  Notification: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
  },
};
