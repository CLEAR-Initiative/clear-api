import { GraphQLError } from "graphql";
import { randomBytes } from "node:crypto";
import type { Context } from "../context.js";
import { requireAuth, isPlatformAdmin } from "../utils/auth-guard.js";
import { attemptDelivery, MAX_ATTEMPTS } from "../services/webhook/deliver.js";

/**
 * Platform-admin-only guard. Webhook subscriptions are a system-wide
 * integration surface, not per-org — restricting to platform admins
 * mirrors how apiKeyResolvers guards its most-privileged paths (revoke).
 */
function requirePlatformAdmin(ctx: Context) {
  const user = requireAuth(ctx);
  if (!isPlatformAdmin(user)) {
    throw new GraphQLError("Platform admin required", {
      extensions: { code: "FORBIDDEN" },
    });
  }
  return user;
}

/** 32 random bytes hex-encoded — 64 chars, ~256 bits of entropy.
 * Same shape as `openssl rand -hex 32`. */
function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/** URL validation with an explicit https-only rule for prod safety.
 * Dev + tests can pass http://localhost:PORT via the same call — we
 * only reject the shape http-to-a-non-localhost host, which is the
 * footgun (unencrypted payloads to public networks). */
function assertValidTargetUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GraphQLError("Invalid targetUrl — must be an absolute URL", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (parsed.protocol === "https:") return;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return;
  }
  throw new GraphQLError(
    "targetUrl must use https (http allowed only for localhost)",
    { extensions: { code: "BAD_USER_INPUT" } },
  );
}

/** Derive delivery status from the timestamp/counter fields.
 * Duplicates the derivation logic on the client — kept server-side so
 * the wire format is self-describing. */
function deriveStatus(row: {
  succeededAt: Date | null;
  nextRetryAt: Date | null;
  attemptNumber: number;
}): "pending" | "succeeded" | "retrying" | "dead" {
  if (row.succeededAt) return "succeeded";
  if (row.attemptNumber >= MAX_ATTEMPTS && !row.nextRetryAt) return "dead";
  if (row.nextRetryAt) return "retrying";
  return "pending";
}

export const webhookResolvers = {
  WebhookSubscription: {
    /**
     * `recentDeliveries` is exposed on the subscription type so the
     * detail page can render "list + inline history" in a single
     * GraphQL round-trip. Capped in the resolver to protect the API
     * from a huge subscription's history being requested implicitly.
     */
    recentDeliveries: (parent: { id: string }, _args: unknown, ctx: Context) => {
      return ctx.prisma.webhookDelivery.findMany({
        where: { subscriptionId: parent.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },
  },

  WebhookDelivery: {
    status: (parent: {
      succeededAt: Date | null;
      nextRetryAt: Date | null;
      attemptNumber: number;
    }) => deriveStatus(parent),
  },

  Query: {
    webhookSubscriptions: async (_parent: unknown, _args: unknown, ctx: Context) => {
      requirePlatformAdmin(ctx);
      const rows = await ctx.prisma.webhookSubscription.findMany({
        orderBy: { createdAt: "desc" },
      });
      // Scrub secrets from list view — only createWebhookSubscription /
      // rotateWebhookSubscriptionSecret expose them.
      return rows.map((r) => ({ ...r, secret: null }));
    },

    webhookSubscription: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      const row = await ctx.prisma.webhookSubscription.findUnique({
        where: { id: args.id },
      });
      if (!row) return null;
      return { ...row, secret: null };
    },

    webhookDeliveries: (
      _parent: unknown,
      args: { subscriptionId: string; limit?: number | null },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      return ctx.prisma.webhookDelivery.findMany({
        where: { subscriptionId: args.subscriptionId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    },
  },

  Mutation: {
    createWebhookSubscription: async (
      _parent: unknown,
      args: {
        input: {
          name: string;
          targetUrl: string;
          eventTypeFilter?: string[] | null;
          active?: boolean | null;
        };
      },
      ctx: Context,
    ) => {
      const admin = requirePlatformAdmin(ctx);
      assertValidTargetUrl(args.input.targetUrl);
      // NB: the `secret` field is returned exactly ONCE, right here.
      // Reads through the list/get resolvers scrub it; the client is
      // expected to persist / show it inline at this moment.
      return ctx.prisma.webhookSubscription.create({
        data: {
          name: args.input.name,
          targetUrl: args.input.targetUrl,
          secret: generateSecret(),
          eventTypeFilter: args.input.eventTypeFilter ?? [],
          active: args.input.active ?? true,
          createdBy: admin.id,
        },
      });
    },

    updateWebhookSubscription: async (
      _parent: unknown,
      args: {
        id: string;
        input: {
          name?: string | null;
          targetUrl?: string | null;
          eventTypeFilter?: string[] | null;
          active?: boolean | null;
        };
      },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      if (args.input.targetUrl) assertValidTargetUrl(args.input.targetUrl);
      const row = await ctx.prisma.webhookSubscription.update({
        where: { id: args.id },
        data: {
          ...(args.input.name !== undefined && args.input.name !== null
            ? { name: args.input.name }
            : {}),
          ...(args.input.targetUrl !== undefined && args.input.targetUrl !== null
            ? { targetUrl: args.input.targetUrl }
            : {}),
          ...(args.input.eventTypeFilter !== undefined && args.input.eventTypeFilter !== null
            ? { eventTypeFilter: args.input.eventTypeFilter }
            : {}),
          ...(args.input.active !== undefined && args.input.active !== null
            ? { active: args.input.active }
            : {}),
        },
      });
      return { ...row, secret: null };
    },

    deleteWebhookSubscription: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      // Cascade set in the Prisma schema removes delivery history too.
      await ctx.prisma.webhookSubscription.delete({ where: { id: args.id } });
      return true;
    },

    rotateWebhookSubscriptionSecret: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      // NB: same one-shot semantics as create — this response is the
      // only place the new secret is visible. Existing deliveries
      // in-flight will continue using whichever secret they read; new
      // events use the new secret.
      return ctx.prisma.webhookSubscription.update({
        where: { id: args.id },
        data: { secret: generateSecret() },
      });
    },

    sendTestWebhookEvent: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      const sub = await ctx.prisma.webhookSubscription.findUnique({
        where: { id: args.id },
      });
      if (!sub) {
        throw new GraphQLError("Subscription not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      // Synthetic payload mimicking GlitchTip's Slack-style alert
      // format so downstream verifiers see the same shape they'd see
      // from a real alert.
      const testPayload = {
        alias: "test.ping",
        text: "Test event from clear-api webhook admin",
        issue_id: `test-${Date.now()}`,
        project: "clear-api",
        triggered_by: ctx.user?.email ?? "unknown",
        timestamp: new Date().toISOString(),
      };
      const delivery = await ctx.prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          eventId: testPayload.issue_id,
          eventType: testPayload.alias,
          requestBody: testPayload,
        },
      });
      // Fire the attempt inline and await it — for a test-fire the
      // user expects the outcome in the response, not eventually via
      // history polling.
      await attemptDelivery(ctx.prisma, delivery.id);
      const refreshed = await ctx.prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      return refreshed;
    },

    retryWebhookDelivery: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ) => {
      requirePlatformAdmin(ctx);
      // Reset the row to "pending immediate retry". The worker picks
      // it up on the next tick; alternatively we could fire inline,
      // but the worker path exercises the same code as an automated
      // retry, which we want.
      await ctx.prisma.webhookDelivery.update({
        where: { id: args.id },
        data: {
          attemptNumber: 1,
          nextRetryAt: new Date(),
          succeededAt: null,
          responseStatus: null,
          responseBody: null,
          error: null,
        },
      });
      return ctx.prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: args.id },
      });
    },
  },
};
