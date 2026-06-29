/**
 * Unit tests for `locationMetadata.resolver.ts` — the DB-FREE branches only.
 *
 * The DB-backed happy path for `upsertLocationMetadata` (the close+insert
 * transaction) is already covered by `tests/resolvers/location.resolver.test.ts`,
 * so it is NOT duplicated here. These tests stub `context.prisma.*` with
 * `vi.fn()` delegates and focus on logic that needs no real DB:
 *
 *   Queries (locationMetadata / allLocationMetadata / locationMetadataHistory):
 *     - the requireAuth gate, and
 *     - the `current` flag → `validTo: null` filter (default true, opt-out),
 *       plus the optional `type` filter on `locationMetadata`.
 *   Mutations:
 *     - upsertLocationMetadata: requireRole(admin|pipeline) gate + NOT_FOUND
 *       branch when the location is missing (no $transaction reached).
 *     - upsertLocationMetadataBatch: requireRole(admin) gate + the two
 *       short-circuit returns (empty inputs, and all-unknown locationIds).
 *     - deleteLocationMetadata: requireRole(admin) gate + count→boolean.
 *
 * SKIPPED (needs a real DB / no unit-testable logic): the successful
 * $transaction paths of upsertLocationMetadata and upsertLocationMetadataBatch,
 * and the trivial LocationMetadata.location field passthrough.
 */

import { describe, it, expect, vi } from "vitest";
import { locationMetadataResolvers } from "../../src/resolvers/locationMetadata.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const VIEWER = { id: "u1", role: "viewer" };
const ADMIN = { id: "a1", role: "admin" };
const PIPELINE = { id: "p1", role: "pipeline" };

const { locationMetadata, allLocationMetadata, locationMetadataHistory } =
  locationMetadataResolvers.Query;
const { upsertLocationMetadata, upsertLocationMetadataBatch, deleteLocationMetadata } =
  locationMetadataResolvers.Mutation;

describe("Query.locationMetadata", () => {
  it("defaults to current-only and orders by validFrom desc", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await locationMetadata(null, { locationId: "L1" }, ctx);
    const call = findMany.mock.calls[0][0];
    expect(call.where).toEqual({ locationId: "L1", validTo: null });
    expect(call.orderBy).toEqual({ validFrom: "desc" });
  });

  it("adds the type filter when type is supplied", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await locationMetadata(null, { locationId: "L1", type: "displacement" }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({
      locationId: "L1",
      type: "displacement",
      validTo: null,
    });
  });

  it("omits the current filter when current=false", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await locationMetadata(null, { locationId: "L1", current: false }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ locationId: "L1" });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    const findMany = vi.fn();
    await expect(
      locationMetadata(null, { locationId: "L1" }, buildContext(null, { locationMetadata: { findMany } })),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("Query.allLocationMetadata", () => {
  it("filters by type and current-only by default", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await allLocationMetadata(null, { type: "displacement" }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({
      type: "displacement",
      validTo: null,
    });
  });

  it("omits the current filter when current=false", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await allLocationMetadata(null, { type: "displacement", current: false }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ type: "displacement" });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      allLocationMetadata(null, { type: "x" }, buildContext(null, { locationMetadata: { findMany: vi.fn() } })),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Query.locationMetadataHistory", () => {
  it("returns all rows for (locationId, type) regardless of validTo", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { locationMetadata: { findMany } });
    await locationMetadataHistory(null, { locationId: "L1", type: "displacement" }, ctx);
    const call = findMany.mock.calls[0][0];
    expect(call.where).toEqual({ locationId: "L1", type: "displacement" });
    expect(call.orderBy).toEqual({ validFrom: "desc" });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      locationMetadataHistory(
        null,
        { locationId: "L1", type: "x" },
        buildContext(null, { locationMetadata: { findMany: vi.fn() } }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Mutation.upsertLocationMetadata — auth + NOT_FOUND", () => {
  const input = { locationId: "L1", type: "displacement", data: { idps: 100 } };

  it("throws FORBIDDEN for a viewer (only admin|pipeline allowed)", async () => {
    const $transaction = vi.fn();
    const findUnique = vi.fn();
    const ctx = buildContext(VIEWER, { locations: { findUnique }, $transaction });
    await expect(upsertLocationMetadata(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the location does not exist and never opens a transaction", async () => {
    const $transaction = vi.fn();
    const findUnique = vi.fn().mockResolvedValue(null);
    const ctx = buildContext(ADMIN, { locations: { findUnique }, $transaction });
    await expect(upsertLocationMetadata(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "L1" },
      select: { id: true },
    });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("allows the pipeline role to pass the gate (reaches the location lookup)", async () => {
    const $transaction = vi.fn();
    const findUnique = vi.fn().mockResolvedValue(null); // still NOT_FOUND, but gate passed
    const ctx = buildContext(PIPELINE, { locations: { findUnique }, $transaction });
    await expect(upsertLocationMetadata(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(findUnique).toHaveBeenCalledOnce();
  });
});

describe("Mutation.upsertLocationMetadataBatch — auth + short-circuits", () => {
  const input = { locationId: "L1", type: "displacement", data: { idps: 1 } };

  it("requires admin (pipeline is NOT allowed here)", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(PIPELINE, { locations: { findMany } });
    await expect(
      upsertLocationMetadataBatch(null, { inputs: [input] }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns [] for empty inputs without touching prisma", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(ADMIN, { locations: { findMany } });
    expect(await upsertLocationMetadataBatch(null, { inputs: [] }, ctx)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("dedupes requested ids in the existence lookup and returns [] when none are valid", async () => {
    const findMany = vi.fn().mockResolvedValue([]); // no location matched
    const $transaction = vi.fn();
    const ctx = buildContext(ADMIN, { locations: { findMany }, $transaction });

    const result = await upsertLocationMetadataBatch(
      null,
      { inputs: [input, { ...input }, { ...input, locationId: "L2" }] },
      ctx,
    );

    expect(result).toEqual([]);
    // Existence check uses a de-duplicated id set.
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["L1", "L2"] } },
      select: { id: true },
    });
    // No valid rows → no transaction.
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      upsertLocationMetadataBatch(null, { inputs: [input] }, buildContext(null, {})),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Mutation.deleteLocationMetadata", () => {
  it("requires admin", async () => {
    const updateMany = vi.fn();
    const ctx = buildContext(PIPELINE, { locationMetadata: { updateMany } });
    await expect(
      deleteLocationMetadata(null, { locationId: "L1", type: "x" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("closes the current row and returns true when a row was affected", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const ctx = buildContext(ADMIN, { locationMetadata: { updateMany } });
    const result = await deleteLocationMetadata(
      null,
      { locationId: "L1", type: "displacement" },
      ctx,
    );
    expect(result).toBe(true);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ locationId: "L1", type: "displacement", validTo: null });
    expect(call.data.validTo).toBeInstanceOf(Date);
  });

  it("returns false when no open row matched", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const ctx = buildContext(ADMIN, { locationMetadata: { updateMany } });
    expect(
      await deleteLocationMetadata(null, { locationId: "L1", type: "x" }, ctx),
    ).toBe(false);
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      deleteLocationMetadata(
        null,
        { locationId: "L1", type: "x" },
        buildContext(null, { locationMetadata: { updateMany: vi.fn() } }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});
