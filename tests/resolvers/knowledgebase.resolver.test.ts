/**
 * Tests for `resolveKnowledgebaseLocation`'s name resolution, focused on
 * the multi-level ambiguity guard: a name that exists at more than one
 * admin level (e.g. "Kassala" as a state AND a locality) must resolve to
 * null, not silently pick the deepest match. DB-free — `$queryRaw` is a
 * per-test stub returning canned rows.
 */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";

import { knowledgebaseResolvers } from "../../src/resolvers/knowledgebase.resolver.js";
import type { Context } from "../../src/context.js";

const resolve = knowledgebaseResolvers.Query.resolveKnowledgebaseLocation;

function ctx(
  queryRaw: ReturnType<typeof vi.fn>,
  role: string | null = "pipeline",
): Context {
  return {
    prisma: { $queryRaw: queryRaw } as unknown as Context["prisma"],
    user: role ? ({ id: "u", role } as unknown) : null,
    session: null,
    authMethod: role ? "session" : null,
  } as unknown as Context;
}

describe("resolveKnowledgebaseLocation — name-level ambiguity", () => {
  it("returns null when a name matches more than one admin level", async () => {
    // "Kassala": state (level 1) and locality (level 2). Ambiguous.
    const q = vi.fn().mockResolvedValue([
      { id: "kassala-state", level: 1 },
      { id: "kassala-locality", level: 2 },
    ]);
    expect(await resolve(null, { name: "Kassala" }, ctx(q))).toBeNull();
  });

  it("resolves a name unique to one level (even with several same-level rows)", async () => {
    const q = vi.fn().mockResolvedValue([
      { id: "nyala-a2", level: 2 },
    ]);
    expect(await resolve(null, { name: "Nyala" }, ctx(q))).toBe("nyala-a2");
  });

  it("returns null when the name matches nothing", async () => {
    const q = vi.fn().mockResolvedValue([]);
    expect(await resolve(null, { name: "Nowhereville" }, ctx(q))).toBeNull();
  });

  it("an explicit adminLevel bypasses the ambiguity guard (level-scoped match)", async () => {
    // adminLevel provided → single level queried, no ambiguity possible.
    const q = vi.fn().mockResolvedValue([{ id: "kassala-state" }]);
    expect(await resolve(null, { name: "Kassala", adminLevel: 1 }, ctx(q))).toBe("kassala-state");
  });

  it("requires the admin/pipeline role", async () => {
    const q = vi.fn().mockResolvedValue([]);
    await expect(resolve(null, { name: "Kassala" }, ctx(q, "viewer")))
      .rejects.toThrow(GraphQLError);
  });
});
