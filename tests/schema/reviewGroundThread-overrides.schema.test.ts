/**
 * Schema contract (#625): the hotline inbox sends reviewer edits as
 * `reviewGroundThread(overrides: GroundPromotionOverridesInput)` and the
 * reject menu as `rejectReason`, and reads `GroundThread.rejectReason`.
 * Resolver-unit tests never validate the operation against the schema,
 * so this executes real operations through an ApolloServer instance.
 *
 * DB-FREE: `context.prisma` stubs only the delegates the resolvers touch.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrls: vi.fn(async () => []),
  uploadBufferToS3: vi.fn(),
}));

function buildContext(reviewState: string) {
  const created: Array<Record<string, unknown>> = [];
  const thread = {
    id: "t1",
    groundSourceId: "gs_1",
    title: "Strike at the market",
    lifecycleState: "reported",
    reviewState,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    rejectReason: null,
    promotedSignalId: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    source: { reviewerRoles: ["admin", "analyst"] },
    messages: [
      {
        externalId: "whatsapp:+100:SM1",
        sentAt: new Date("2026-09-01T00:00:00Z"),
        text: "Market hit",
        mediaKeys: [],
        omittedMediaCount: 0,
        classification: "field_report",
        uncertainty: null,
        isEdited: false,
      },
    ],
  };
  const context = {
    prisma: {
      locations: { findUnique: vi.fn(async () => ({ id: "loc_1" })) },
      groundThreads: {
        findUnique: vi.fn(async () => thread),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...thread, ...args.data })),
      },
      dataSources: {
        findFirst: vi.fn(async () => ({ id: "ds_whatsapp" })),
        findUnique: vi.fn(async () => ({ id: "ds_whatsapp", name: "whatsapp", type: "whatsapp" })),
      },
      signals: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: "sig_1", ...args.data };
        }),
      },
    },
    user: { id: "u1", role: "analyst" },
    session: null,
    authMethod: "session",
    locale: "en",
  } as unknown as Context;
  return { context, created };
}

async function run(query: string, context: Context) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation({ query }, { contextValue: context });
  await server.stop();
  if (response.body.kind !== "single") throw new Error("expected a single result");
  return response.body.singleResult;
}

describe("reviewGroundThread overrides / rejectReason schema contract", () => {
  it("accepts overrides on approve_public and applies them to the signal", async () => {
    const { context, created } = buildContext("unverified");
    const result = await run(
      `mutation {
        reviewGroundThread(
          id: "t1"
          decision: "approve_public"
          overrides: { title: "Edited", description: "Edited body", severity: 3, locationId: "loc_1" }
        ) { id reviewState promotedSignalId rejectReason }
      }`,
      context,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.reviewGroundThread).toEqual({
      id: "t1",
      reviewState: "approved_public",
      promotedSignalId: "sig_1",
      rejectReason: null,
    });
    expect(created[0]).toMatchObject({
      title: "Edited",
      description: "Edited body",
      severity: 3,
      locationId: "loc_1",
    });
  });

  it("accepts rejectReason on reject and exposes it on GroundThread", async () => {
    const { context } = buildContext("unverified");
    const result = await run(
      `mutation {
        reviewGroundThread(id: "t1", decision: "reject", rejectReason: "duplicate") {
          reviewState rejectReason
        }
      }`,
      context,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.reviewGroundThread).toEqual({ reviewState: "rejected", rejectReason: "duplicate" });
  });

  it("returns BAD_USER_INPUT for an out-of-range severity", async () => {
    const { context, created } = buildContext("unverified");
    const result = await run(
      `mutation {
        reviewGroundThread(id: "t1", decision: "approve_public", overrides: { severity: 9 }) { id }
      }`,
      context,
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(created).toHaveLength(0);
  });
});
