import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import type { Channel, Frequency } from "../generated/prisma/client.js";
import { requireAuth, requireRole } from "../utils/auth-guard.js";

interface SubscribeToAlertsInput {
  locationId: string;
  alertType: string;
  channel: Channel;
  frequency: Frequency;
  minSeverity?: number;
}

interface UpdateAlertSubscriptionInput {
  channel?: Channel;
  frequency?: Frequency;
  active?: boolean;
  minSeverity?: number;
}

interface SubscribeToAlertsBatchInput {
  locationIds: string[];
  alertTypes: string[];
  channel: Channel;
  frequency: Frequency;
  minSeverity?: number;
}

function validateSeverity(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new GraphQLError("minSeverity must be an integer between 1 and 5", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return value;
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
          minSeverity: validateSeverity(input.minSeverity) ?? 1,
        },
      });
    },

    subscribeToAlertsBatch: async (
      _parent: unknown,
      args: { input: SubscribeToAlertsBatchInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { input } = args;

      if (input.locationIds.length === 0 || input.alertTypes.length === 0) {
        throw new GraphQLError("locationIds and alertTypes must each contain at least one value", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const minSeverity = validateSeverity(input.minSeverity) ?? 1;

      // De-dupe incoming pairs in case the caller sent the same value twice
      const uniqueLocationIds = [...new Set(input.locationIds)];
      const uniqueAlertTypes = [...new Set(input.alertTypes)];

      // Verify all referenced locations exist in one query
      const foundLocations = await context.prisma.locations.findMany({
        where: { id: { in: uniqueLocationIds } },
        select: { id: true },
      });
      if (foundLocations.length !== uniqueLocationIds.length) {
        const foundSet = new Set(foundLocations.map((l) => l.id));
        const missing = uniqueLocationIds.filter((id) => !foundSet.has(id));
        throw new GraphQLError(`Location(s) not found: ${missing.join(", ")}`, {
          extensions: { code: "NOT_FOUND" },
        });
      }

      // Load existing subscriptions for this user in the requested scope so
      // we can skip duplicates silently (vs the single-create which errors)
      const existing = await context.prisma.userAlertSubscriptions.findMany({
        where: {
          userId: user.id,
          locationId: { in: uniqueLocationIds },
          alertType: { in: uniqueAlertTypes },
          channel: input.channel,
        },
        select: { locationId: true, alertType: true },
      });
      const existingKeys = new Set(
        existing.map((s) => `${s.locationId}::${s.alertType}`),
      );

      const toCreate: {
        userId: string;
        locationId: string;
        alertType: string;
        channel: Channel;
        frequency: Frequency;
        minSeverity: number;
      }[] = [];
      for (const locationId of uniqueLocationIds) {
        for (const alertType of uniqueAlertTypes) {
          if (existingKeys.has(`${locationId}::${alertType}`)) continue;
          toCreate.push({
            userId: user.id,
            locationId,
            alertType,
            channel: input.channel,
            frequency: input.frequency,
            minSeverity,
          });
        }
      }

      if (toCreate.length === 0) return [];

      // Create all rows in one round-trip; then return them
      await context.prisma.userAlertSubscriptions.createMany({
        data: toCreate,
        skipDuplicates: true,
      });

      return context.prisma.userAlertSubscriptions.findMany({
        where: {
          userId: user.id,
          locationId: { in: uniqueLocationIds },
          alertType: { in: uniqueAlertTypes },
          channel: input.channel,
        },
        orderBy: { createdAt: "desc" },
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
          minSeverity: validateSeverity(input.minSeverity) ?? undefined,
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
