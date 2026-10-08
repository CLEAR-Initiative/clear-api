/**
 * Tests for the auth model on signal creation.
 *
 * `createSignal` is admin/analyst only — the pipeline integrations
 * (Dataminr, ACLED, GDACS) authenticate as system admin/analyst users via
 * API key. Viewers and pending users are rejected.
 *
 * `createManualSignal` allows either global admin/analyst OR a team-scoped
 * writer, and enforces TRUSTED_SOURCE_NAMES on the dataSource independent of
 * the user's role.
 *
 * DB-FREE: `context.prisma` is a `vi.fn()` mock — `dataSources.findUnique`
 * returns a canned source by id (dataminr = non-trusted, field_officer =
 * trusted), `signals.create` echoes the row. The audit-log writer is
 * module-mocked so nothing touches the DB.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";

// Canned dataSource rows keyed by id (were dev-DB seed ids; now just mock keys).
const DATAMINR_SOURCE_ID = "src-dataminr";          // name=dataminr  → NOT trusted
const FIELD_OFFICER_SOURCE_ID = "src-field-officer"; // name=field_officer → trusted
const ACTOR_ID = "actor-1";

const SOURCES: Record<string, { id: string; name: string; type: string }> = {
  [DATAMINR_SOURCE_ID]: { id: DATAMINR_SOURCE_ID, name: "dataminr", type: "api" },
  [FIELD_OFFICER_SOURCE_ID]: { id: FIELD_OFFICER_SOURCE_ID, name: "field_officer", type: "manual" },
};

function makePrisma() {
  return {
    dataSources: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => SOURCES[where.id] ?? null),
    },
    signals: {
      findUnique: vi.fn(async () => null), // no existing row → no idempotency short-circuit
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sig-new", ...data })),
    },
  };
}

function ctx(user: { id: string; role: string } | null): Context {
  return {
    prisma: makePrisma(), user, session: null,
    authMethod: user ? "session" : null, locale: "en",
  } as unknown as Context;
}

describe("signal resolver — auth model on signal creation", () => {
  describe("createSignal", () => {
    const base = () => ({
      sourceId: DATAMINR_SOURCE_ID, title: "TEST signal", description: "d",
      publishedAt: new Date().toISOString(), rawData: { test: true },
      externalId: `test:${Math.random().toString(36).slice(2)}`,
    });

    it("allows an analyst-role user to create a signal", async () => {
      const result = await signalResolvers.Mutation.createSignal(
        null, { input: { ...base(), title: "TEST analyst-created signal" } },
        ctx({ id: ACTOR_ID, role: "analyst" }),
      );
      expect(result.id).toBeTruthy();
      expect(result.title).toBe("TEST analyst-created signal");
    });

    it("rejects a viewer-role user with FORBIDDEN", async () => {
      await expect(
        signalResolvers.Mutation.createSignal(null, { input: base() }, ctx({ id: ACTOR_ID, role: "viewer" })),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
      await expect(
        signalResolvers.Mutation.createSignal(null, { input: base() }, ctx(null)),
      ).rejects.toThrow(GraphQLError);
    });

    it("still works for admin (regression)", async () => {
      const result = await signalResolvers.Mutation.createSignal(
        null, { input: { ...base(), title: "TEST admin-created signal" } },
        ctx({ id: ACTOR_ID, role: "admin" }),
      );
      expect(result.id).toBeTruthy();
    });
  });

  describe("createManualSignal", () => {
    it("allows an admin to file a manual signal on a trusted source", async () => {
      const result = await signalResolvers.Mutation.createManualSignal(
        null,
        { input: { sourceId: FIELD_OFFICER_SOURCE_ID, title: "TEST admin-filed manual signal", description: "d", severity: 4 } },
        ctx({ id: ACTOR_ID, role: "admin" }),
      );
      expect(result.id).toBeTruthy();
    });

    it("rejects a viewer without a teamId with FORBIDDEN", async () => {
      await expect(
        signalResolvers.Mutation.createManualSignal(
          null, { input: { sourceId: FIELD_OFFICER_SOURCE_ID, title: "TEST", description: "d", severity: 4 } },
          ctx({ id: ACTOR_ID, role: "viewer" }),
        ),
      ).rejects.toThrow(/insufficient permissions/i);
    });

    it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
      await expect(
        signalResolvers.Mutation.createManualSignal(
          null, { input: { sourceId: FIELD_OFFICER_SOURCE_ID, title: "TEST", description: "d" } }, ctx(null),
        ),
      ).rejects.toThrow(GraphQLError);
    });

    it("rejects a non-trusted source even for an admin", async () => {
      await expect(
        signalResolvers.Mutation.createManualSignal(
          null, { input: { sourceId: DATAMINR_SOURCE_ID, title: "TEST", description: "d" } },
          ctx({ id: ACTOR_ID, role: "admin" }),
        ),
      ).rejects.toThrow(/trusted source/i);
    });
  });
});

describe("signal resolver — setSignalGlideCode", () => {
  function glideCtx(user: { id: string; role: string } | null, existing: { id: string } | null) {
    const prisma = {
      signals: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          // Prisma's update on a missing row throws P2025.
          if (!existing) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
          return { id: where.id, ...data };
        }),
      },
    };
    const context = {
      prisma, user, session: null, authMethod: user ? "session" : null, locale: "en",
    } as unknown as Context;
    return { prisma, context };
  }

  it("records the glide code for the pipeline role", async () => {
    const { prisma, context } = glideCtx({ id: ACTOR_ID, role: "pipeline" }, { id: "sig-1" });
    const result = await signalResolvers.Mutation.setSignalGlideCode(
      null, { id: "sig-1", glideCode: "ba" }, context,
    );
    expect(result).toMatchObject({ id: "sig-1", glideCode: "ba" });
    expect(prisma.signals.update).toHaveBeenCalledWith({ where: { id: "sig-1" }, data: { glideCode: "ba" } });
  });

  it("rejects an analyst with FORBIDDEN", async () => {
    const { prisma, context } = glideCtx({ id: ACTOR_ID, role: "analyst" }, { id: "sig-1" });
    await expect(
      signalResolvers.Mutation.setSignalGlideCode(null, { id: "sig-1", glideCode: "ba" }, context),
    ).rejects.toThrow(/insufficient permissions/i);
    expect(prisma.signals.update).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for an unknown signal", async () => {
    const { prisma, context } = glideCtx({ id: ACTOR_ID, role: "admin" }, null);
    const err = await signalResolvers.Mutation.setSignalGlideCode(
      null, { id: "missing", glideCode: "ba" }, context,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe("NOT_FOUND");
    expect(prisma.signals.update).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other database error unchanged", async () => {
    const { prisma, context } = glideCtx({ id: ACTOR_ID, role: "admin" }, { id: "sig-1" });
    prisma.signals.update.mockRejectedValueOnce(Object.assign(new Error("db down"), { code: "P1001" }));
    await expect(
      signalResolvers.Mutation.setSignalGlideCode(null, { id: "sig-1", glideCode: "ba" }, context),
    ).rejects.toThrow("db down");
  });
});
