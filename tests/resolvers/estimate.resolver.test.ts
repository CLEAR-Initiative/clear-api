/**
 * Tests for the Estimate resolvers (CLEAR Domain Ontology v0.3.0).
 *
 * DB-FREE: `context.prisma` is `vi.fn()` delegates. These assert who may
 * read `Event.estimates` and what each argument asks Prisma for. The
 * migration's rules (bounds CHECK, immutability trigger, one supersession
 * per Estimate, the backfill) run against the real schema in
 * `estimate.db.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { estimateResolvers } from "../../src/resolvers/estimate.resolver.js";
import type { Context } from "../../src/context.js";

function makeContext(user: { id: string; role: string } | null) {
  const prisma = {
    estimate: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    events: { findUniqueOrThrow: vi.fn(async () => ({ id: "ev-1" })) },
    user: { findUnique: vi.fn(async () => null) },
  };
  const context = { prisma, user, session: null, authMethod: "session" } as unknown as Context;
  return { context, prisma };
}

const estimates = estimateResolvers.Event.estimates;

function makeEstimate(overrides: Record<string, unknown> = {}) {
  return {
    id: "est-1",
    eventId: "ev-1",
    metric: "people_affected",
    populationGroup: null,
    value: 1200,
    unit: "people",
    lowerBound: null,
    upperBound: null,
    method: "not_documented",
    attribution: "event_caused",
    validFor: new Date("2026-09-01T00:00:00Z"),
    estimatedAt: new Date("2026-10-07T00:00:00Z"),
    isGroundTruth: false,
    sourceSignalId: null,
    sourceUrl: null,
    supersedesId: null,
    definitionVersion: "0.3.0",
    createdById: null,
    createdAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  } as Parameters<typeof estimateResolvers.Estimate.event>[0];
}

describe("Event.estimates", () => {
  it("follows the Event's visibility: refuses an anonymous caller", () => {
    const { context, prisma } = makeContext(null);
    expect(() => estimates({ id: "ev-1" }, {}, context)).toThrow(GraphQLError);
    expect(prisma.estimate.findMany).not.toHaveBeenCalled();
  });

  it("refuses an account awaiting approval", () => {
    const { context } = makeContext({ id: "u-1", role: "viewer_pending" });
    expect(() => estimates({ id: "ev-1" }, {}, context)).toThrow(/awaiting admin approval/);
  });

  it("returns the whole history of the Event's figures, newest first, to any content reader", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    await estimates({ id: "ev-1" }, {}, context);
    expect(prisma.estimate.findMany).toHaveBeenCalledWith({
      where: { eventId: "ev-1" },
      orderBy: [{ estimatedAt: "desc" }, { id: "desc" }],
    });
  });

  it("lets a Worker read figures (an ImpactPrior is computed from them)", async () => {
    const { context, prisma } = makeContext({ id: "u-w", role: "worker" });
    await estimates({ id: "ev-1" }, {}, context);
    expect(prisma.estimate.findMany).toHaveBeenCalled();
  });

  it("narrows to one metric and to the not-yet-superseded Estimates", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "analyst" });
    await estimates({ id: "ev-1" }, { metric: "people_displaced_new", current: true }, context);
    expect(prisma.estimate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "ev-1", metric: "people_displaced_new", supersededBy: { is: null } },
      }),
    );
  });

  it("treats current: false and a null metric as no filter", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "analyst" });
    await estimates({ id: "ev-1" }, { metric: null, current: false }, context);
    expect(prisma.estimate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev-1" } }),
    );
  });
});

describe("Estimate fields", () => {
  it("supersedes is null without a lookup when the Estimate corrects nothing", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    expect(await estimateResolvers.Estimate.supersedes(makeEstimate(), {}, context)).toBeNull();
    expect(prisma.estimate.findUnique).not.toHaveBeenCalled();
  });

  it("supersedes loads the Estimate it corrects", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    await estimateResolvers.Estimate.supersedes(makeEstimate({ supersedesId: "est-0" }), {}, context);
    expect(prisma.estimate.findUnique).toHaveBeenCalledWith({ where: { id: "est-0" } });
  });

  it("supersededBy finds the one correction pointing at it", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    await estimateResolvers.Estimate.supersededBy(makeEstimate(), {}, context);
    expect(prisma.estimate.findUnique).toHaveBeenCalledWith({ where: { supersedesId: "est-1" } });
  });

  it("createdBy is null for system-written Estimates", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    expect(await estimateResolvers.Estimate.createdBy(makeEstimate(), {}, context)).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("event resolves the Estimate's subject", async () => {
    const { context, prisma } = makeContext({ id: "u-1", role: "viewer" });
    await estimateResolvers.Estimate.event(makeEstimate(), {}, context);
    expect(prisma.events.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "ev-1" } });
  });
});
