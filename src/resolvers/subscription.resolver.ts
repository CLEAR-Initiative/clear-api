import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { Channel, Frequency } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface SubscribeToAlertsInput {
  locationId: string;
  alertType: string;
  channel: Channel;
  frequency: Frequency;
}

interface UpdateAlertSubscriptionInput {
  channel?: Channel;
  frequency?: Frequency;
  active?: boolean;
}

export const subscriptionResolvers = {
  Query: {
    myAlertSubscriptions: async (_parent: unknown, _args: unknown, context: Context) => {
      const user = requireAuth(context);
      return context.prisma.userAlertSubscriptions.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
    },

    alertSubscriptionsByLocation: async (
      _parent: unknown,
      args: { locationId: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return context.prisma.userAlertSubscriptions.findMany({
        where: { locationId: args.locationId },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    subscribeToAlerts: async (
      _parent: unknown,
      args: { input: SubscribeToAlertsInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { input } = args;

      // Verify location exists
      const location = await context.prisma.locations.findUnique({
        where: { id: input.locationId },
      });
      if (!location) {
        throw new GraphQLError("Location not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Check for duplicate subscription
      const existing = await context.prisma.userAlertSubscriptions.findFirst({
        where: {
          userId: user.id,
          locationId: input.locationId,
          alertType: input.alertType,
          channel: input.channel,
        },
      });
      if (existing) {
        throw new GraphQLError("You already have a subscription for this type, location, and channel", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      return context.prisma.userAlertSubscriptions.create({
        data: {
          userId: user.id,
          locationId: input.locationId,
          alertType: input.alertType,
          channel: input.channel,
          frequency: input.frequency,
        },
      });
    },

    updateAlertSubscription: async (
      _parent: unknown,
      args: { id: string; input: UpdateAlertSubscriptionInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { id, input } = args;

      const subscription = await context.prisma.userAlertSubscriptions.findUnique({
        where: { id },
      });
      if (!subscription) {
        throw new GraphQLError("Subscription not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (subscription.userId !== user.id && user.role !== "admin") {
        throw new GraphQLError("Not authorized to update this subscription", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      return context.prisma.userAlertSubscriptions.update({
        where: { id },
        data: {
          channel: input.channel ?? undefined,
          frequency: input.frequency ?? undefined,
          active: input.active ?? undefined,
        },
      });
    },

    unsubscribeFromAlerts: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const subscription = await context.prisma.userAlertSubscriptions.findUnique({
        where: { id: args.id },
      });
      if (!subscription) {
        throw new GraphQLError("Subscription not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (subscription.userId !== user.id && user.role !== "admin") {
        throw new GraphQLError("Not authorized to delete this subscription", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      await context.prisma.userAlertSubscriptions.delete({ where: { id: args.id } });
      return true;
    },
  },

  AlertSubscription: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    location: (parent: { locationId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.locations.findUnique({ where: { id: parent.locationId } });
    },
  },
};
