/**
 * Unit tests for `dataSource.resolver.ts`.
 *
 * DB-free: `context.prisma.dataSources` (and `.signals`) are stubbed per-test
 * with `vi.fn()` delegates. Covers:
 *   1. The `requireRole(["admin"])` gate on every mutation
 *      (FORBIDDEN for non-admins, UNAUTHENTICATED when logged out).
 *   2. `createDataSource` defaulting `isActive` to `true` and passing the
 *      remaining fields through verbatim.
 *   3. `updateDataSource` / `deleteDataSource` NOT_FOUND branch and the
 *      `?? undefined` partial-update mapping.
 *   4. The `DataSource.signals` field resolver filtering by `sourceId`.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { dataSourceResolvers } from "../../src/resolvers/dataSource.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, dataSources: Record<string, unknown> = {}, signals: Record<string, unknown> = {}): Context {
  return {
    prisma: { dataSources, signals } as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { createDataSource, updateDataSource, deleteDataSource } = dataSourceResolvers.Mutation;

describe("Mutation.createDataSource", () => {
  it("creates a source, defaulting isActive to true", async () => {
    const created = { id: "ds1" };
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext({ id: "a1", role: "admin" }, { create });

    const result = await createDataSource(
      null,
      { input: { name: "GDACS", type: "rss", baseUrl: "https://x", infoUrl: "https://y" } },
      ctx,
    );

    expect(result).toBe(created);
    expect(create.mock.calls[0][0].data).toEqual({
      name: "GDACS",
      type: "rss",
      isActive: true,
      baseUrl: "https://x",
      infoUrl: "https://y",
    });
  });

  it("respects an explicit isActive: false", async () => {
    const create = vi.fn().mockResolvedValue({ id: "ds1" });
    const ctx = buildContext({ id: "a1", role: "admin" }, { create });
    await createDataSource(null, { input: { name: "n", type: "t", isActive: false } }, ctx);
    expect(create.mock.calls[0][0].data.isActive).toBe(false);
  });

  it("throws FORBIDDEN for a non-admin and does not write", async () => {
    const create = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, { create });
    await expect(
      createDataSource(null, { input: { name: "n", type: "t" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when logged out", async () => {
    await expect(
      createDataSource(null, { input: { name: "n", type: "t" } }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });
});

describe("Mutation.updateDataSource", () => {
  it("maps absent fields to undefined and passes baseUrl/infoUrl through", async () => {
    const update = vi.fn().mockResolvedValue({ id: "ds1" });
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      findUnique: vi.fn().mockResolvedValue({ id: "ds1" }),
      update,
    });

    await updateDataSource(null, { id: "ds1", input: { name: "new" } }, ctx);

    expect(update.mock.calls[0][0].where).toEqual({ id: "ds1" });
    expect(update.mock.calls[0][0].data).toEqual({
      name: "new",
      type: undefined,
      isActive: undefined,
      baseUrl: undefined,
      infoUrl: undefined,
    });
  });

  it("throws NOT_FOUND when the source does not exist", async () => {
    const update = vi.fn();
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      findUnique: vi.fn().mockResolvedValue(null),
      update,
    });
    await expect(
      updateDataSource(null, { id: "missing", input: { name: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a non-admin before any lookup", async () => {
    const findUnique = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, { findUnique });
    await expect(
      updateDataSource(null, { id: "ds1", input: { name: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("Mutation.deleteDataSource", () => {
  it("deletes an existing source and returns true", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      findUnique: vi.fn().mockResolvedValue({ id: "ds1" }),
      delete: del,
    });
    const result = await deleteDataSource(null, { id: "ds1" }, ctx);
    expect(result).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "ds1" } });
  });

  it("throws NOT_FOUND and does not delete when absent", async () => {
    const del = vi.fn();
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      findUnique: vi.fn().mockResolvedValue(null),
      delete: del,
    });
    await expect(
      deleteDataSource(null, { id: "missing" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN for a non-admin", async () => {
    await expect(
      deleteDataSource(null, { id: "ds1" }, buildContext({ id: "u1", role: "viewer" })),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("DataSource.signals field resolver", () => {
  it("filters signals by the parent source id", () => {
    const rows = [{ id: "s1" }];
    const findMany = vi.fn().mockReturnValue(rows);
    const ctx = buildContext(null, {}, { findMany });
    const result = dataSourceResolvers.DataSource.signals({ id: "ds1" }, {}, ctx);
    expect(result).toBe(rows);
    expect(findMany).toHaveBeenCalledWith({ where: { sourceId: "ds1" } });
  });
});
