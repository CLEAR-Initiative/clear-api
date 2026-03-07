import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";
import { generateApiKey } from "../utils/api-key.js";

export const apiKeyResolvers = {
  Query: {
    myApiKeys: (_parent: unknown, _args: unknown, context: Context) => {
      const user = requireAuth(context);
      return context.prisma.apiKey.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    createApiKey: async (
      _parent: unknown,
      args: { input: { name: string; expiresAt?: string } },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const activeCount = await context.prisma.apiKey.count({
        where: { userId: user.id, revokedAt: null },
      });
      if (activeCount >= 10) {
        throw new GraphQLError(
          "Maximum of 10 active API keys per user. Revoke an existing key first.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const { plaintextKey, prefix, keyHash } = generateApiKey();

      const apiKey = await context.prisma.apiKey.create({
        data: {
          userId: user.id,
          name: args.input.name,
          prefix,
          keyHash,
          expiresAt: args.input.expiresAt
            ? new Date(args.input.expiresAt)
            : null,
        },
      });

      return { apiKey, key: plaintextKey };
    },

    revokeApiKey: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const apiKey = await context.prisma.apiKey.findUnique({
        where: { id: args.id },
      });

      if (!apiKey) {
        throw new GraphQLError("API key not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      if (apiKey.userId !== user.id && user.role !== "admin") {
        throw new GraphQLError("Insufficient permissions", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      if (apiKey.revokedAt) {
        throw new GraphQLError("API key is already revoked", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      return context.prisma.apiKey.update({
        where: { id: args.id },
        data: { revokedAt: new Date() },
      });
    },
  },
};
