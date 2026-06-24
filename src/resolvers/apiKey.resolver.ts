import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireContentReader } from "../utils/auth-guard.js";
import { generateApiKey } from "../utils/api-key.js";

export const apiKeyResolvers = {
  Query: {
    myApiKeys: (_parent: unknown, _args: unknown, context: Context) => {
      // Approved users only. Pending accounts have no use for API keys
      // — any key they minted would inherit the pending role and be
      // rejected by every read/write gate anyway.
      const user = requireContentReader(context);
      return context.prisma.apiKeys.findMany({
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
      // Approved users only — blocks pending accounts. A pending user
      // shouldn't be able to mint a credential before an admin has
      // signed off; the FORBIDDEN error carries `subCode:
      // PENDING_APPROVAL` so the portal UI renders the waiting screen
      // language verbatim.
      const user = requireContentReader(context);

      const activeCount = await context.prisma.apiKeys.count({
        where: { userId: user.id, revokedAt: null },
      });
      if (activeCount >= 10) {
        throw new GraphQLError(
          "Maximum of 10 active API keys per user. Revoke an existing key first.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const { plaintextKey, prefix, keyHash } = generateApiKey();

      const apiKey = await context.prisma.apiKeys.create({
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
      // Approved users only. Symmetric with createApiKey above — pending
      // users have nothing to revoke (they couldn't have minted one),
      // and gating consistently keeps the API key surface coherent.
      const user = requireContentReader(context);

      const apiKey = await context.prisma.apiKeys.findUnique({
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

      return context.prisma.apiKeys.update({
        where: { id: args.id },
        data: { revokedAt: new Date() },
      });
    },
  },
};
