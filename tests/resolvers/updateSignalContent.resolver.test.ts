/**
 * Tests for updateSignalContent — applies an in-place content revision to an
 * existing signal (e.g. IDMC IDU rows being revised upstream, same id,
 * changed figures/role/dates/location). Hash-gated: only writes when the
 * incoming contentHash differs from what's stored.
 *
 * Tests run against the real database (DATABASE_URL from `.env`). All
 * created rows are tracked and DELETEd in `afterAll`. The dataminr
 * DataSource is looked up by name rather than a hardcoded id, since that id
 * is only stable within whichever DB seeded it (see
 * signal.resolver.test.ts's DATAMINR_SOURCE_ID for the same issue).
 *
 * Skipped automatically when DATABASE_URL is missing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GraphQLError } from "graphql";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

function buildContext(user: { id: string; role: string } | null): Context {
  return {
    prisma,
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as Context;
}

describeIfDb("updateSignalContent", () => {
  const createdSignalIds: string[] = [];
  const createdLocationIds: string[] = [];
  let viewerUserId: string;
  let dataminrSourceId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) {
      throw new Error("No user in DB to use as test actor — seed at least one user first.");
    }
    viewerUserId = user.id;

    const dataminr = await prisma.dataSources.findFirst({
      where: { name: "dataminr" },
      select: { id: true },
    });
    if (!dataminr) {
      throw new Error("No 'dataminr' DataSource seeded — required for these tests.");
    }
    dataminrSourceId = dataminr.id;
  });

  afterAll(async () => {
    if (createdSignalIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "signals" WHERE id = ANY(${createdSignalIds}::text[])`;
    }
    if (createdLocationIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${createdLocationIds}::text[])`;
    }
    await prisma.$disconnect();
  });

  async function createTestSignal(overrides: Record<string, unknown> = {}) {
    const ctx = buildContext({ id: viewerUserId, role: "admin" });
    const result = await signalResolvers.Mutation.createSignal(
      null,
      {
        input: {
          sourceId: dataminrSourceId,
          title: "TEST signal for updateSignalContent",
          description: "seed row",
          publishedAt: new Date().toISOString(),
          rawData: { test: true },
          externalId: `test:update-content:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...overrides,
        },
      },
      ctx,
    );
    createdSignalIds.push(result.id);
    if (result.locationId) createdLocationIds.push(result.locationId);
    return result;
  }

  it("rejects a viewer-role user with FORBIDDEN", async () => {
    const created = await createTestSignal();
    const ctx = buildContext({ id: viewerUserId, role: "viewer" });
    await expect(
      signalResolvers.Mutation.updateSignalContent(
        null,
        { input: { id: created.id, contentHash: "h1", rawData: { test: true } } },
        ctx,
      ),
    ).rejects.toThrow(/insufficient permissions/i);
  });

  it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
    const created = await createTestSignal();
    const ctx = buildContext(null);
    await expect(
      signalResolvers.Mutation.updateSignalContent(
        null,
        { input: { id: created.id, contentHash: "h1", rawData: { test: true } } },
        ctx,
      ),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND for an id that doesn't exist", async () => {
    const ctx = buildContext({ id: viewerUserId, role: "admin" });
    await expect(
      signalResolvers.Mutation.updateSignalContent(
        null,
        { input: { id: "does-not-exist", contentHash: "h1", rawData: { test: true } } },
        ctx,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("writes content fields and sets lastRevisedAt when contentHash differs", async () => {
    const created = await createTestSignal({ rawData: { figure: 1000 }, severity: 2 });
    const ctx = buildContext({ id: viewerUserId, role: "admin" });

    const updated = await signalResolvers.Mutation.updateSignalContent(
      null,
      {
        input: {
          id: created.id,
          contentHash: "revision-1",
          rawData: { figure: 1500 },
          severity: 3,
          title: "TEST revised title",
        },
      },
      ctx,
    );

    expect(updated.contentHash).toBe("revision-1");
    expect(updated.severity).toBe(3);
    expect(updated.title).toBe("TEST revised title");
    expect(updated.lastRevisedAt).toBeTruthy();
  });

  it("is a no-op when contentHash matches what's already stored", async () => {
    const created = await createTestSignal({ rawData: { figure: 1000 }, severity: 2 });
    const ctx = buildContext({ id: viewerUserId, role: "admin" });

    const first = await signalResolvers.Mutation.updateSignalContent(
      null,
      {
        input: { id: created.id, contentHash: "revision-a", rawData: { figure: 1500 }, severity: 3 },
      },
      ctx,
    );
    expect(first.severity).toBe(3);

    // Same contentHash again, deliberately different payload — must be
    // ignored, proving the hash-gate actually gates (a Redis-TTL-expiry
    // false-positive resend is exactly this shape).
    const second = await signalResolvers.Mutation.updateSignalContent(
      null,
      {
        input: { id: created.id, contentHash: "revision-a", rawData: { figure: 9999 }, severity: 5 },
      },
      ctx,
    );
    expect(second.severity).toBe(3);
    expect(second.lastRevisedAt).toEqual(first.lastRevisedAt);
  });

  it("resolves a new locationId from lat/lng when none is explicit, same as createSignal", async () => {
    const created = await createTestSignal();
    const ctx = buildContext({ id: viewerUserId, role: "admin" });

    const updated = await signalResolvers.Mutation.updateSignalContent(
      null,
      {
        input: {
          id: created.id,
          contentHash: "revision-with-coords",
          rawData: { test: true },
          lat: 13.601,
          lng: 24.755,
        },
      },
      ctx,
    );
    if (updated.locationId) createdLocationIds.push(updated.locationId);

    expect(updated.locationId).toBeTruthy();
  });
});
