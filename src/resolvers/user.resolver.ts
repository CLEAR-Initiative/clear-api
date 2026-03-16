import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

interface UpdateProfileInput {
  name?: string;
  phoneNumber?: string;
  image?: string;
  enableInAppNotification?: boolean;
  enableEmailNotification?: boolean;
  enableSMSNotification?: boolean;
}

export const userResolvers = {
  Query: {
    users: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.user.findMany();
    },
    user: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    updateProfile: async (
      _parent: unknown,
      args: { input: UpdateProfileInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { input } = args;

      const data: Record<string, string | boolean> = {};

      if (input.name !== undefined) {
        data.name = input.name;
      }

      if (input.image !== undefined) {
        data.image = input.image;
      }

      if (input.phoneNumber !== undefined) {
        const e164Regex = /^\+[1-9]\d{1,14}$/;
        if (input.phoneNumber !== "" && !e164Regex.test(input.phoneNumber)) {
          throw new GraphQLError(
            "Phone number must be in E.164 format (e.g. +249912345678)",
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
        data.phoneNumber = input.phoneNumber;
      }

      if (input.enableInAppNotification !== undefined) {
        data.inAppNotification = input.enableInAppNotification;
      }

      if (input.enableEmailNotification !== undefined) {
        data.emailNotification = input.enableEmailNotification;
      }

      if (input.enableSMSNotification !== undefined) {
        if (input.enableSMSNotification) {
          const phoneNumber = input.phoneNumber ?? (
            await context.prisma.user.findUnique({
              where: { id: user.id },
              select: { phoneNumber: true },
            })
          )?.phoneNumber;

          if (!phoneNumber) {
            throw new GraphQLError(
              "A phone number is required to enable SMS notifications",
              { extensions: { code: "BAD_USER_INPUT" } },
            );
          }
        }
        data.smsNotification = input.enableSMSNotification;
      }

      return context.prisma.user.update({
        where: { id: user.id },
        data,
      });
    },
  },
  User: {
    alerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userAlerts.findMany({ where: { userId: parent.id } });
    },
    notifications: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.notifications.findMany({
        where: { userId: parent.id },
        orderBy: { createdAt: "desc" },
      });
    },
    organisations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.organisationUsers.findMany({ where: { userId: parent.id } });
    },
    feedbacks: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userFeedbacks.findMany({ where: { userId: parent.id } });
    },
    comments: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findMany({ where: { userId: parent.id } });
    },
    escalations: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.eventEscaladedByUsers.findMany({ where: { userId: parent.id } });
    },
  },
};
