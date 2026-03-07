import { GraphQLError } from "graphql";
import { randomBytes } from "crypto";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

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
      _args: unknown,
      context: Context,
    ) => {
      const user = requireAuth(context);

      if (user.emailVerified) {
        throw new GraphQLError("Email is already verified", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await context.prisma.verification.create({
        data: {
          identifier: user.email,
          value: token,
          expiresAt,
        },
      });

      // TODO: Send verification email via messaging provider
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
  },
};
