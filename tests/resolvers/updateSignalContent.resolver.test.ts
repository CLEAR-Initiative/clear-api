/**
 * Tests for updateSignalContent — applies an in-place content revision to an
 * existing signal (e.g. IDMC IDU rows being revised upstream, same id,
 * changed figures/role/dates/location). Hash-gated: only writes when the
 * incoming contentHash differs from what's stored.
 *
 * DB-FREE: `context.prisma` is a small STATEFUL mock (findUnique returns the
 * current row; update mutates it), so the hash-gating / lastRevisedAt logic is
 * exercised across calls without a seeded database. `createPointLocation` (the
 * only PostGIS dependency, via resolveLocationId) is mocked — its spatial
 * correctness is covered by the DB-gated geo-resolve.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

vi.mock("../../src/utils/geo-resolve.js", () => ({
  createPointLocation: vi.fn().mockResolvedValue({ id: "point-loc-1", name: "pt", level: 4 }),
  getLocationIdsWithDescendants: vi.fn().mockResolvedValue([]),
}));

import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";

const update = signalResolvers.Mutation.updateSignalContent;

/** Stateful mock of the two `signals` delegates the resolver touches — enough
 *  to make the cross-call hash-gate behave like a real row. */
function makePrisma(initial: Record<string, unknown> | null) {
  let stored: Record<string, unknown> | null = initial ? { ...initial } : null;
  return {
    signals: {
      findUnique: vi.fn(async () => (stored ? { ...stored } : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...(stored ?? {}), ...data };
        return { ...stored };
      }),
    },
  };
}

function ctx(prisma: unknown, user: { id: string; role: string } | null): Context {
  return {
    prisma, user, session: null, authMethod: user ? "session" : null, locale: "en",
  } as unknown as Context;
}

describe("updateSignalContent", () => {
  it("rejects a viewer-role user with FORBIDDEN", async () => {
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: { test: true } } },
        ctx(makePrisma({ id: "s1" }), { id: "u", role: "viewer" })),
    ).rejects.toThrow(/insufficient permissions/i);
  });

  it("rejects an unauthenticated request with UNAUTHENTICATED", async () => {
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: { test: true } } },
        ctx(makePrisma({ id: "s1" }), null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND for an id that doesn't exist", async () => {
    await expect(
      update(null, { input: { id: "does-not-exist", contentHash: "h1", rawData: { test: true } } },
        ctx(makePrisma(null), { id: "u", role: "admin" })),
    ).rejects.toThrow(/not found/i);
  });

  it("writes content fields and sets lastRevisedAt when contentHash differs", async () => {
    const prisma = makePrisma({ id: "s1", contentHash: "baseline", severity: 2, lastRevisedAt: null });
    const updated = await update(
      null,
      { input: { id: "s1", contentHash: "revision-1", rawData: { figure: 1500 }, severity: 3, title: "TEST revised title" } },
      ctx(prisma, { id: "u", role: "admin" }),
    );
    expect(updated.contentHash).toBe("revision-1");
    expect(updated.severity).toBe(3);
    expect(updated.title).toBe("TEST revised title");
    expect(updated.lastRevisedAt).toBeTruthy();
  });

  it("is a no-op when contentHash matches what's already stored", async () => {
    // Seed a legacy null-hash row; the first call seeds the hash (no stamp),
    // the second with the SAME hash must be ignored (the gate actually gates).
    const prisma = makePrisma({ id: "s1", contentHash: null, severity: 2, lastRevisedAt: null });
    const c = ctx(prisma, { id: "u", role: "admin" });

    const first = await update(null, { input: { id: "s1", contentHash: "revision-a", rawData: { figure: 1500 }, severity: 3 } }, c);
    expect(first.severity).toBe(3);

    const second = await update(null, { input: { id: "s1", contentHash: "revision-a", rawData: { figure: 9999 }, severity: 5 } }, c);
    expect(second.severity).toBe(3);                     // ignored
    expect(second.lastRevisedAt).toEqual(first.lastRevisedAt);
    expect(prisma.signals.update).toHaveBeenCalledTimes(1); // only the first call wrote
  });

  it("does not set lastRevisedAt when the stored contentHash already matches", async () => {
    const prisma = makePrisma({ id: "s1", contentHash: "seeded-hash-1", lastRevisedAt: null });
    const updated = await update(
      null, { input: { id: "s1", contentHash: "seeded-hash-1", rawData: { test: true } } },
      ctx(prisma, { id: "u", role: "admin" }),
    );
    expect(updated.lastRevisedAt).toBe(null);
    expect(updated.contentHash).toBe("seeded-hash-1");
  });

  it("seeds a legacy null contentHash without stamping, then stamps on the next real revision", async () => {
    const prisma = makePrisma({ id: "s1", contentHash: null, lastRevisedAt: null });
    const c = ctx(prisma, { id: "u", role: "admin" });

    const seeded = await update(null, { input: { id: "s1", contentHash: "first-real-hash", rawData: { test: true }, severity: 4 } }, c);
    expect(seeded.contentHash).toBe("first-real-hash");
    expect(seeded.severity).toBe(4);
    expect(seeded.lastRevisedAt).toBe(null); // first seed → no stamp

    const revised = await update(null, { input: { id: "s1", contentHash: "second-real-hash", rawData: { test: true }, severity: 5 } }, c);
    expect(revised.severity).toBe(5);
    expect(revised.lastRevisedAt).toBeTruthy(); // real revision → stamped
  });

  it("resolves a new locationId from lat/lng via createPointLocation", async () => {
    const prisma = makePrisma({ id: "s1", contentHash: "baseline" });
    const updated = await update(
      null,
      { input: { id: "s1", contentHash: "revision-with-coords", rawData: { test: true }, lat: 13.601, lng: 24.755 } },
      ctx(prisma, { id: "u", role: "admin" }),
    );
    expect(updated.locationId).toBe("point-loc-1"); // from the mocked point-location resolver
  });
});
