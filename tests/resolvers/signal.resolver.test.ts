/**
 * Tests for the role-relaxed auth on signal creation.
 *
 * Pre-change behaviour: `createSignal` and `createManualSignal` both required
 * the global `admin` or `analyst` role. The change opens both to any
 * authenticated user — non-admin / non-analyst users (the default `viewer`
 * role, and anything else) can now file signals. This is intentional; the
 * downstream pipeline gates (severity >= 4, staleness, TRUSTED_SOURCE_NAMES
 * on the manual path) carry the integrity load.
 *
 * Tests run against the real database (DATABASE_URL from `.env`). All
 * created rows are tracked and DELETEd in `afterAll`. `sendCeleryTask` is
 * mocked at the module level so manual-signal tests don't actually queue
 * pipeline work against Redis.
 *
 * Skipped automatically when DATABASE_URL is missing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GraphQLError } from "graphql";

// Mock the Celery dispatch BEFORE importing the resolver — the resolver
// imports sendCeleryTask at module load and we want our mock to be the
// binding it picks up.
vi.mock("../../src/services/celery.js", () => ({
  sendCeleryTask: vi.fn(async () => undefined),
}));

import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { sendCeleryTask } from "../../src/services/celery.js";
import type { Context } from "../../src/context.js";

const enabled = !!process.env.DATABASE_URL;
const describeIfDb = enabled ? describe : describe.skip;

// Source ids confirmed to exist in the dev DB (see seed data). Tests use
// the same data_sources rows the production pipeline does, so the resolver's
// dataSource.findUnique succeeds and the TRUSTED_SOURCE_NAMES check goes
// through its real code path.
const DATAMINR_SOURCE_ID = "cmmw90wux0004ec9kdxdee7lr";        // type=api,    name=dataminr (NON-trusted)
const FIELD_OFFICER_SOURCE_ID = "9df2265c-ff6c-400c-8d0a-0a48b4b09159"; // trusted

function buildContext(user: { id: string; role: string } | null): Context {
  // Minimal Context shape — resolvers only read `prisma` + `user` for these
  // mutations. `session` / `authMethod` are present on the real Context but
  // unread inside createSignal / createManualSignal.
  return {
    prisma,
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  };
}

describeIfDb("signal resolver — role relaxation on signal creation", () => {
  const createdSignalIds: string[] = [];
  const createdLocationIds: string[] = [];
  let viewerUserId: string;

  beforeAll(async () => {
    // Pull any existing user id from the DB to use as the actor. We only
    // need a user that has the FK target for signals via api keys / etc.;
    // role assignment in the Context is independent of the DB row.
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) {
      throw new Error("No user in DB to use as test actor — seed at least one user first.");
    }
    viewerUserId = user.id;
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

  // ──────────────────────────────────────────────────────────────────────
  // createSignal — the generic mutation used by the pipeline workers
  // ──────────────────────────────────────────────────────────────────────
  describe("createSignal", () => {
    it("allows a viewer-role user to create a signal", async () => {
      const ctx = buildContext({ id: viewerUserId, role: "viewer" });
      const result = await signalResolvers.Mutation.createSignal(
        null,
        {
          input: {
            sourceId: DATAMINR_SOURCE_ID,
            title: "TEST viewer-created signal",
            description: "Created in the role-relaxation test",
            // publishedAt is a required field on CreateSignalInput.
            publishedAt: new Date().toISOString(),
            rawData: { test: true },
            // No coords / location — keeps the test hermetic and avoids
            // the createPointLocation path.
            externalId: `test:viewer:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
        },
        ctx,
      );
      createdSignalIds.push(result.id);
      expect(result.id).toBeTruthy();
      expect(result.title).toBe("TEST viewer-created signal");
    });

    it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
      const ctx = buildContext(null);
      await expect(
        signalResolvers.Mutation.createSignal(
          null,
          {
            input: {
              sourceId: DATAMINR_SOURCE_ID,
              title: "TEST should fail",
              description: "no user",
              publishedAt: new Date().toISOString(),
            rawData: { test: true },
            },
          },
          ctx,
        ),
      ).rejects.toThrow(GraphQLError);
    });

    it("still works for admin (regression — the original role kept working)", async () => {
      const ctx = buildContext({ id: viewerUserId, role: "admin" });
      const result = await signalResolvers.Mutation.createSignal(
        null,
        {
          input: {
            sourceId: DATAMINR_SOURCE_ID,
            title: "TEST admin-created signal",
            description: "Regression check",
            publishedAt: new Date().toISOString(),
            rawData: { test: true },
            externalId: `test:admin:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
        },
        ctx,
      );
      createdSignalIds.push(result.id);
      expect(result.id).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // createManualSignal — the user-facing mutation; trusted-source-only
  // ──────────────────────────────────────────────────────────────────────
  describe("createManualSignal", () => {
    it("allows a viewer-role user to file a manual signal on a trusted source", async () => {
      const ctx = buildContext({ id: viewerUserId, role: "viewer" });
      const result = await signalResolvers.Mutation.createManualSignal(
        null,
        {
          input: {
            sourceId: FIELD_OFFICER_SOURCE_ID,
            title: "TEST viewer-filed manual signal",
            description: "Filed via the relaxed auth path",
            severity: 4,
          },
        },
        ctx,
      );
      createdSignalIds.push(result.id);
      expect(result.id).toBeTruthy();
      // The resolver should have queued a pipeline task — verify our mock
      // got called with the right Celery task name.
      expect(sendCeleryTask).toHaveBeenCalledWith(
        "src.tasks.process.process_manual_signal",
        expect.objectContaining({
          signal_id: result.id,
          source_type: "field_officer",
          user_id: viewerUserId,
        }),
      );
    });

    it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
      const ctx = buildContext(null);
      await expect(
        signalResolvers.Mutation.createManualSignal(
          null,
          {
            input: {
              sourceId: FIELD_OFFICER_SOURCE_ID,
              title: "TEST should fail",
              description: "no user",
            },
          },
          ctx,
        ),
      ).rejects.toThrow(GraphQLError);
    });

    it("rejects a non-trusted source even when called by a viewer", async () => {
      // The TRUSTED_SOURCE_NAMES guard is independent of the user's role —
      // it's a property of the dataSource. Dataminr is `api` type, not
      // trusted for manual entry. This must still throw post-relaxation.
      const ctx = buildContext({ id: viewerUserId, role: "viewer" });
      await expect(
        signalResolvers.Mutation.createManualSignal(
          null,
          {
            input: {
              sourceId: DATAMINR_SOURCE_ID,
              title: "TEST should fail",
              description: "dataminr is not a trusted manual source",
            },
          },
          ctx,
        ),
      ).rejects.toThrow(/trusted source/i);
    });
  });
});
