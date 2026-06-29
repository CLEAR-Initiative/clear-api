/**
 * Unit tests for the location-scoping helpers in `src/utils/location-scope.ts`.
 *
 * These helpers build Prisma `where` clauses that restrict signals/events/
 * crises to a team's (or user's) geographic scope. The scope is the union of a
 * team's bound locations expanded to all administrative descendants.
 *
 * DB-free: `prisma` is stubbed per-test. In particular `$queryRaw` (used by the
 * real `getLocationIdsWithDescendants` for descendant expansion) is replaced
 * with a `vi.fn()` that returns canned rows, so the actual scope-union and
 * filter-shape logic runs without a database. Always runs, including in CI.
 *
 * NOTE: `buildEventLocationFilterForTeam` is a thin typed re-export of
 * `buildLocationFilterForTeam` (same runtime behaviour, different return type),
 * so it is covered by one delegation test rather than a full re-run of every
 * branch.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildLocationFilterForTeam,
  buildEventLocationFilterForTeam,
  buildCrisisLocationFilterForUser,
} from "../../src/utils/location-scope.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

/**
 * Build a stub Prisma client. Each delegate accepts a `vi.fn()` so a test only
 * wires up the calls it exercises. `$queryRaw` is what
 * `getLocationIdsWithDescendants` invokes; the default returns just the queried
 * location id (i.e. "no descendants") unless overridden.
 */
function stubPrisma(overrides: {
  teamLocations?: unknown;
  teamMembers?: unknown;
  queryRaw?: ReturnType<typeof vi.fn>;
}): PrismaClient {
  return {
    teamLocations: { findMany: overrides.teamLocations ?? vi.fn() },
    teamMembers: { findMany: overrides.teamMembers ?? vi.fn() },
    $queryRaw: overrides.queryRaw ?? vi.fn(),
  } as unknown as PrismaClient;
}

/**
 * A `$queryRaw` stub that maps each queried location id to a fixed set of
 * descendant ids (the location itself + descendants), mirroring
 * getLocationIdsWithDescendants's real contract. The id being queried is the
 * first interpolated value the tagged template receives.
 */
function descendantQueryRaw(map: Record<string, string[]>): ReturnType<typeof vi.fn> {
  return vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const locationId = values[0] as string;
    const ids = map[locationId] ?? [locationId];
    return ids.map((id) => ({ id }));
  });
}

describe("buildLocationFilterForTeam", () => {
  it("returns undefined when the team has no locations (global monitoring)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const queryRaw = vi.fn();
    const prisma = stubPrisma({ teamLocations: findMany, queryRaw });

    const result = await buildLocationFilterForTeam(prisma, "team-1");

    expect(result).toBeUndefined();
    expect(findMany).toHaveBeenCalledWith({
      where: { teamId: "team-1" },
      select: { locationId: true },
    });
    // No expansion when there are no locations.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("builds an OR filter over origin/destination/location for a single scoped location with no descendants", async () => {
    const findMany = vi.fn().mockResolvedValue([{ locationId: "loc-A" }]);
    const queryRaw = descendantQueryRaw({ "loc-A": ["loc-A"] });
    const prisma = stubPrisma({ teamLocations: findMany, queryRaw });

    const result = await buildLocationFilterForTeam(prisma, "team-1");

    expect(result).toEqual({
      OR: [
        { originId: { in: ["loc-A"] } },
        { destinationId: { in: ["loc-A"] } },
        { locationId: { in: ["loc-A"] } },
      ],
    });
  });

  it("expands a scope location to include its administrative descendants", async () => {
    const findMany = vi.fn().mockResolvedValue([{ locationId: "sudan" }]);
    const queryRaw = descendantQueryRaw({
      sudan: ["sudan", "khartoum", "darfur"],
    });
    const prisma = stubPrisma({ teamLocations: findMany, queryRaw });

    const result = await buildLocationFilterForTeam(prisma, "team-1");

    expect(result).toEqual({
      OR: [
        { originId: { in: ["sudan", "khartoum", "darfur"] } },
        { destinationId: { in: ["sudan", "khartoum", "darfur"] } },
        { locationId: { in: ["sudan", "khartoum", "darfur"] } },
      ],
    });
  });

  it("unions the descendants of multiple scope locations and de-duplicates overlaps", async () => {
    // Two bound locations whose descendant sets overlap on the shared id.
    const findMany = vi
      .fn()
      .mockResolvedValue([{ locationId: "loc-A" }, { locationId: "loc-B" }]);
    const queryRaw = descendantQueryRaw({
      "loc-A": ["loc-A", "shared"],
      "loc-B": ["loc-B", "shared"],
    });
    const prisma = stubPrisma({ teamLocations: findMany, queryRaw });

    const result = (await buildLocationFilterForTeam(prisma, "team-1")) as {
      OR: { originId: { in: string[] } }[];
    };

    // Set-based union: "shared" appears exactly once, insertion order preserved.
    const ids = result.OR[0]!.originId.in;
    expect(ids).toEqual(["loc-A", "shared", "loc-B"]);
    // All three OR branches reference the same union set.
    expect(result.OR).toEqual([
      { originId: { in: ids } },
      { destinationId: { in: ids } },
      { locationId: { in: ids } },
    ]);
    // One expansion query per bound location.
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("buildEventLocationFilterForTeam", () => {
  it("delegates to buildLocationFilterForTeam and returns the same shape", async () => {
    const findMany = vi.fn().mockResolvedValue([{ locationId: "loc-A" }]);
    const queryRaw = descendantQueryRaw({ "loc-A": ["loc-A", "child"] });
    const prisma = stubPrisma({ teamLocations: findMany, queryRaw });

    const result = await buildEventLocationFilterForTeam(prisma, "team-9");

    expect(result).toEqual({
      OR: [
        { originId: { in: ["loc-A", "child"] } },
        { destinationId: { in: ["loc-A", "child"] } },
        { locationId: { in: ["loc-A", "child"] } },
      ],
    });
  });

  it("returns undefined for a team with no locations (same global-monitoring rule)", async () => {
    const prisma = stubPrisma({
      teamLocations: vi.fn().mockResolvedValue([]),
    });
    expect(await buildEventLocationFilterForTeam(prisma, "team-9")).toBeUndefined();
  });
});

describe("buildCrisisLocationFilterForUser", () => {
  it("returns undefined when the user has no team memberships", async () => {
    const teamMembers = vi.fn().mockResolvedValue([]);
    const teamLocations = vi.fn();
    const prisma = stubPrisma({ teamMembers, teamLocations });

    const result = await buildCrisisLocationFilterForUser(prisma, "user-1");

    expect(result).toBeUndefined();
    expect(teamMembers).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { teamId: true },
    });
    // Short-circuits before looking up locations.
    expect(teamLocations).not.toHaveBeenCalled();
  });

  it("returns undefined when ANY of the user's teams has no location bindings (wide-open team)", async () => {
    // User is in two teams; team-B has bindings but team-A has none → wide open.
    const teamMembers = vi
      .fn()
      .mockResolvedValue([{ teamId: "team-A" }, { teamId: "team-B" }]);
    const teamLocations = vi
      .fn()
      .mockResolvedValue([{ teamId: "team-B", locationId: "loc-B" }]);
    const queryRaw = vi.fn();
    const prisma = stubPrisma({ teamMembers, teamLocations, queryRaw });

    const result = await buildCrisisLocationFilterForUser(prisma, "user-1");

    expect(result).toBeUndefined();
    expect(teamLocations).toHaveBeenCalledWith({
      where: { teamId: { in: ["team-A", "team-B"] } },
      select: { teamId: true, locationId: true },
    });
    // Wide-open short-circuit happens before any descendant expansion.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("builds an EXISTS-shaped eventCrises.some filter over the expanded scope when all teams are bound", async () => {
    const teamMembers = vi.fn().mockResolvedValue([{ teamId: "team-A" }]);
    const teamLocations = vi
      .fn()
      .mockResolvedValue([{ teamId: "team-A", locationId: "sudan" }]);
    const queryRaw = descendantQueryRaw({
      sudan: ["sudan", "khartoum"],
    });
    const prisma = stubPrisma({ teamMembers, teamLocations, queryRaw });

    const result = await buildCrisisLocationFilterForUser(prisma, "user-1");

    expect(result).toEqual({
      eventCrises: {
        some: {
          event: {
            OR: [
              { originId: { in: ["sudan", "khartoum"] } },
              { destinationId: { in: ["sudan", "khartoum"] } },
              { locationId: { in: ["sudan", "khartoum"] } },
            ],
          },
        },
      },
    });
  });

  it("unions bindings across multiple bound teams and de-duplicates the scope set", async () => {
    const teamMembers = vi
      .fn()
      .mockResolvedValue([{ teamId: "team-A" }, { teamId: "team-B" }]);
    const teamLocations = vi.fn().mockResolvedValue([
      { teamId: "team-A", locationId: "loc-A" },
      { teamId: "team-B", locationId: "loc-B" },
    ]);
    const queryRaw = descendantQueryRaw({
      "loc-A": ["loc-A", "shared"],
      "loc-B": ["loc-B", "shared"],
    });
    const prisma = stubPrisma({ teamMembers, teamLocations, queryRaw });

    const result = (await buildCrisisLocationFilterForUser(prisma, "user-1")) as {
      eventCrises: { some: { event: { OR: { originId: { in: string[] } }[] } } };
    };

    const ids = result.eventCrises.some.event.OR[0]!.originId.in;
    expect(ids).toEqual(["loc-A", "shared", "loc-B"]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when bound teams exist but expansion yields an empty scope set", async () => {
    // Defensive branch: a team is recorded as having a binding, but the
    // expansion query returns no rows (e.g. the location was deleted), so the
    // union is empty and the helper declines to build an over-broad filter.
    const teamMembers = vi.fn().mockResolvedValue([{ teamId: "team-A" }]);
    const teamLocations = vi
      .fn()
      .mockResolvedValue([{ teamId: "team-A", locationId: "ghost" }]);
    const queryRaw = vi.fn().mockResolvedValue([]); // expansion finds nothing
    const prisma = stubPrisma({ teamMembers, teamLocations, queryRaw });

    const result = await buildCrisisLocationFilterForUser(prisma, "user-1");

    expect(result).toBeUndefined();
  });
});
