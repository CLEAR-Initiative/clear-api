/**
 * Unit tests for resolving an unresolved place name, DB-free: who may
 * resolve, the shape of a resolution, where a place may be put, the conflict
 * paths, the alias tier of `resolveGazetteerLocation`, and the write in
 * `services/place-names.ts` with a stubbed transaction. The SQL itself is
 * covered by `placeNameResolution.db.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/geo-resolve.js", () => ({
  resolveContainingAdminArea: vi.fn(),
  findOrCreateLandmarkL4: vi.fn(),
  getLocationIdsWithDescendants: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/utils/location-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/location-scope.js")>()),
  getTeamScopeLocationIds: vi.fn(),
}));
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma } from "../../src/generated/prisma/client.js";
import { unresolvedPlaceNameResolvers } from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { gazetteerResolvers } from "../../src/resolvers/gazetteer.resolver.js";
import * as placeNames from "../../src/services/place-names.js";
import { findOrCreateLandmarkL4, resolveContainingAdminArea } from "../../src/utils/geo-resolve.js";
import { getTeamScopeLocationIds } from "../../src/utils/location-scope.js";
import { logActivity } from "../../src/utils/activity-log.js";
import type { Context } from "../../src/context.js";

const { resolveUnresolvedPlaceName } = unresolvedPlaceNameResolvers.Mutation;
const { placeNameSuggestions } = unresolvedPlaceNameResolvers.Query;

type Fn = ReturnType<typeof vi.fn>;
type User = { id: string; role: string } | null;

const PLATFORM = { id: "u-platform", role: "admin" };
const TEAM_ADMIN = { id: "u-admin", role: "member" };
const MEMBER = { id: "u-member", role: "member" };
const WORKER = { id: "u-worker", role: "worker" };

const COUNTRY = { id: "loc-sd", level: 0, ancestorIds: [] as string[] };
const STATE = { id: "loc-state", level: 1, ancestorIds: ["loc-sd"] };
const OTHER_STATE = { id: "loc-state-2", level: 1, ancestorIds: ["loc-sd"] };
const DISTRICT = { id: "loc-district", level: 2, ancestorIds: ["loc-state", "loc-sd"] };
const OTHER_DISTRICT = { id: "loc-district-2", level: 2, ancestorIds: ["loc-state-2", "loc-sd"] };
const ABROAD = { id: "loc-abroad", level: 2, ancestorIds: ["loc-td"] };
const LOCATIONS = [COUNTRY, STATE, OTHER_STATE, DISTRICT, OTHER_DISTRICT, ABROAD];

const ROW = {
  id: "row-1",
  nameNorm: "um dabakir",
  nameAsWritten: "Um Dabakir",
  nameAr: "أم دباكر",
  countryCode: "SD",
  stateLocationId: STATE.id,
  countryLocationId: COUNTRY.id,
  status: "open",
};

interface Fake {
  unresolvedPlaceNames: { findUnique: Fn; updateMany: Fn; update: Fn };
  unresolvedPlaceNameSignals: { count: Fn };
  placeAliases: { create: Fn; createMany: Fn };
  locations: { findUnique: Fn; findFirst: Fn; findMany: Fn };
  geonames: { findUnique: Fn };
  teamMembers: { findMany: Fn };
  $queryRaw: Fn;
  $executeRaw: Fn;
  $transaction: Fn;
}

function fakePrisma(row: Record<string, unknown> | null = ROW): Fake {
  const prisma: Fake = {
    unresolvedPlaceNames: {
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    unresolvedPlaceNameSignals: { count: vi.fn().mockResolvedValue(3) },
    placeAliases: {
      create: vi.fn().mockResolvedValue({ id: "alias-1" }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    locations: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(LOCATIONS.find((l) => l.id === where.id) ?? null),
      ),
      findFirst: vi.fn().mockResolvedValue({ id: COUNTRY.id }),
      findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(LOCATIONS.filter((l) => where.id.in.includes(l.id) && l.level <= 1)),
      ),
    },
    geonames: {
      findUnique: vi.fn().mockResolvedValue({ geonamesId: 7, name: "Um Dabakir", latitude: 12.1, longitude: 30.2, countryCode: "SD" }),
    },
    teamMembers: { findMany: vi.fn().mockResolvedValue([{ teamId: "t1" }]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: Fake) => unknown) => fn(prisma));
  return prisma;
}

function ctx(user: User, prisma: Fake = fakePrisma()): Context {
  return { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en", signalScope: { kind: "full" } } as unknown as Context;
}

const resolveSpy = vi.spyOn(placeNames, "resolveIntoAlias");
const suggestSpy = vi.spyOn(placeNames, "suggestPlaces");
const aliasSpy = vi.spyOn(placeNames, "findPlaceAlias");

beforeEach(() => {
  vi.mocked(getTeamScopeLocationIds).mockReset().mockResolvedValue([STATE.id, DISTRICT.id]);
  vi.mocked(resolveContainingAdminArea).mockReset().mockResolvedValue({ id: DISTRICT.id, name: "District", level: 2 });
  vi.mocked(findOrCreateLandmarkL4).mockReset().mockResolvedValue({
    locationId: "loc-l4",
    reused: false,
    pointType: "landmark-geocoded",
    abortedReason: null,
  });
  vi.mocked(logActivity).mockClear();
  resolveSpy.mockReset().mockResolvedValue({ aliasId: "alias-1", signalsMoved: 2 });
  suggestSpy.mockReset().mockResolvedValue([]);
  aliasSpy.mockReset().mockResolvedValue(null);
});

const run = (user: User, resolution: Record<string, unknown>, prisma: Fake = fakePrisma(), note?: string) =>
  resolveUnresolvedPlaceName(null, { id: ROW.id, resolution: resolution as never, note }, ctx(user, prisma));

describe("resolveUnresolvedPlaceName", () => {
  it("is for deciders: not a worker, not a member who administers no team", async () => {
    await expect(run(WORKER, { kind: "NOT_A_PLACE" })).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const prisma = fakePrisma();
    prisma.teamMembers.findMany.mockResolvedValue([]);
    await expect(run(MEMBER, { kind: "NOT_A_PLACE" }, prisma)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(prisma.unresolvedPlaceNames.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a missing row, a row outside the team's area and a closed row", async () => {
    await expect(run(PLATFORM, { kind: "NOT_A_PLACE" }, fakePrisma(null))).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    const outside = fakePrisma({ ...ROW, stateLocationId: OTHER_STATE.id });
    await expect(run(TEAM_ADMIN, { kind: "NOT_A_PLACE" }, outside)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    for (const status of ["resolved", "not_a_place"]) {
      await expect(run(PLATFORM, { kind: "AMBIGUOUS" }, fakePrisma({ ...ROW, status }))).rejects.toMatchObject({
        extensions: { code: "CONFLICT" },
      });
    }
    await expect(run(PLATFORM, { kind: "AMBIGUOUS" }, fakePrisma({ ...ROW, status: "ambiguous" }))).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });

  it("closes a row as not a place or ambiguous, once", async () => {
    const prisma = fakePrisma();
    await run(TEAM_ADMIN, { kind: "NOT_A_PLACE" }, prisma, " Plural of kambo ");
    expect(prisma.unresolvedPlaceNames.updateMany).toHaveBeenCalledWith({
      where: { id: ROW.id, status: { in: ["open", "ambiguous"] } },
      data: expect.objectContaining({ status: "not_a_place", resolvedById: TEAM_ADMIN.id, resolutionNote: "Plural of kambo" }),
    });
    expect(logActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({ action: "place_name.not_a_place", resourceId: ROW.id }));
    expect(resolveSpy).not.toHaveBeenCalled();

    await run(PLATFORM, { kind: "AMBIGUOUS" });
    expect(logActivity).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "place_name.ambiguous" }));

    const lost = fakePrisma();
    lost.unresolvedPlaceNames.updateMany.mockResolvedValue({ count: 0 });
    await expect(run(PLATFORM, { kind: "NOT_A_PLACE" }, lost)).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("takes exactly the field its kind needs", async () => {
    const bad = [
      { kind: "LOCATION" },
      { kind: "LOCATION", locationId: DISTRICT.id, geonamesId: 7 },
      { kind: "GEONAMES" },
      { kind: "POINT" },
      { kind: "AMBIGUOUS", point: { lat: 1, lng: 1 } },
      { kind: "POINT", point: { lat: 91, lng: 1 } },
      { kind: "POINT", point: { lat: 1, lng: 181 } },
    ];
    for (const resolution of bad) {
      await expect(run(PLATFORM, resolution)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
    await expect(run(PLATFORM, { kind: "NOT_A_PLACE" }, fakePrisma(), "x".repeat(2001))).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("answers with an existing location inside the row's state", async () => {
    const prisma = fakePrisma();
    await run(TEAM_ADMIN, { kind: "LOCATION", locationId: DISTRICT.id }, prisma, "Known");
    expect(resolveSpy).toHaveBeenCalledWith(prisma, {
      row: ROW,
      locationId: DISTRICT.id,
      userId: TEAM_ADMIN.id,
      note: "Known",
      source: "review",
    });
    expect(logActivity).toHaveBeenCalledWith(prisma, {
      userId: TEAM_ADMIN.id,
      action: "place_name.resolve",
      resourceType: "place_name",
      resourceId: ROW.id,
      metadata: expect.objectContaining({ kind: "LOCATION", locationId: DISTRICT.id, placeAliasId: "alias-1", signalsMoved: 2 }),
    });
  });

  it("keeps a team admin inside the state, and everyone inside the country", async () => {
    await expect(run(TEAM_ADMIN, { kind: "LOCATION", locationId: OTHER_DISTRICT.id })).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await expect(run(PLATFORM, { kind: "LOCATION", locationId: OTHER_DISTRICT.id })).resolves.toBeDefined();
    for (const locationId of [ABROAD.id, COUNTRY.id, "no-such-location"]) {
      await expect(run(PLATFORM, { kind: "LOCATION", locationId })).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    // A row with no state: its country is the home.
    const countryRow = fakePrisma({ ...ROW, stateLocationId: null });
    vi.mocked(getTeamScopeLocationIds).mockResolvedValue([COUNTRY.id, STATE.id, OTHER_STATE.id]);
    await expect(run(TEAM_ADMIN, { kind: "LOCATION", locationId: OTHER_DISTRICT.id }, countryRow)).resolves.toBeDefined();
  });

  it("turns a GeoNames answer into a landmark under the row's state", async () => {
    const prisma = fakePrisma();
    await run(TEAM_ADMIN, { kind: "GEONAMES", geonamesId: 7 }, prisma);
    expect(resolveContainingAdminArea).toHaveBeenCalledWith(prisma, 12.1, 30.2);
    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(prisma, {
      name: "Um Dabakir",
      lat: 12.1,
      lng: 30.2,
      kind: "admin",
      withinId: STATE.id,
    });
    expect(resolveSpy).toHaveBeenCalledWith(prisma, expect.objectContaining({ locationId: "loc-l4" }));
  });

  it("refuses a GeoNames answer that is unknown or in another country", async () => {
    const unknown = fakePrisma();
    unknown.geonames.findUnique.mockResolvedValue(null);
    await expect(run(PLATFORM, { kind: "GEONAMES", geonamesId: 1 }, unknown)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    const abroad = fakePrisma();
    abroad.geonames.findUnique.mockResolvedValue({ geonamesId: 9, name: "X", latitude: 1, longitude: 1, countryCode: "TD" });
    await expect(run(PLATFORM, { kind: "GEONAMES", geonamesId: 9 }, abroad)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(findOrCreateLandmarkL4).not.toHaveBeenCalled();
  });

  it("names a new point after the row, and checks where it falls", async () => {
    const prisma = fakePrisma();
    await run(TEAM_ADMIN, { kind: "POINT", point: { lat: 12, lng: 30 } }, prisma);
    expect(findOrCreateLandmarkL4).toHaveBeenCalledWith(prisma, expect.objectContaining({ name: "Um Dabakir", withinId: STATE.id }));
    await run(TEAM_ADMIN, { kind: "POINT", point: { lat: 12, lng: 30, name: " Um Dabakir power station " } }, prisma);
    expect(findOrCreateLandmarkL4).toHaveBeenLastCalledWith(prisma, expect.objectContaining({ name: "Um Dabakir power station" }));

    // Outside every area CLEAR covers.
    vi.mocked(resolveContainingAdminArea).mockResolvedValue(null);
    await expect(run(PLATFORM, { kind: "POINT", point: { lat: 1, lng: 1 } })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    // In another state: refused for a team admin; a platform admin places it
    // there, under the area that holds the point.
    vi.mocked(resolveContainingAdminArea).mockResolvedValue({ id: OTHER_DISTRICT.id, name: "Other", level: 2 });
    await expect(run(TEAM_ADMIN, { kind: "POINT", point: { lat: 12, lng: 31 } })).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await run(PLATFORM, { kind: "POINT", point: { lat: 12, lng: 31 } });
    expect(findOrCreateLandmarkL4).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ withinId: OTHER_DISTRICT.id }));
  });

  it("fails when the landmark cannot be made", async () => {
    vi.mocked(findOrCreateLandmarkL4).mockResolvedValue({ locationId: null, reused: false, pointType: null, abortedReason: "different_a2" });
    await expect(run(PLATFORM, { kind: "POINT", point: { lat: 12, lng: 30 } })).rejects.toMatchObject({
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("maps a lost race and an existing alias to CONFLICT, and rethrows the rest", async () => {
    for (const reason of ["ROW_CLOSED", "ALIAS_EXISTS"] as const) {
      resolveSpy.mockRejectedValueOnce(new placeNames.PlaceNameConflict(reason));
      await expect(run(PLATFORM, { kind: "LOCATION", locationId: DISTRICT.id })).rejects.toMatchObject({
        extensions: { code: "CONFLICT" },
      });
    }
    resolveSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(run(PLATFORM, { kind: "LOCATION", locationId: DISTRICT.id })).rejects.toThrow("db down");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("counts the Signals a resolution moved", async () => {
    const prisma = fakePrisma();
    expect(await unresolvedPlaceNameResolvers.UnresolvedPlaceName.signalsMoved({ id: "row-1" }, null, ctx(PLATFORM, prisma))).toBe(3);
    expect(prisma.unresolvedPlaceNameSignals.count).toHaveBeenCalledWith({
      where: { unresolvedPlaceNameId: "row-1", relocatedAt: { not: null } },
    });
  });
});

describe("placeNameSuggestions", () => {
  it("searches inside the country of the area", async () => {
    const prisma = fakePrisma();
    await placeNameSuggestions(null, { name: " Um Dabakir ", nameAr: "أم دباكر", countryCode: "sd", withinLocationId: DISTRICT.id }, ctx(TEAM_ADMIN, prisma));
    expect(suggestSpy).toHaveBeenCalledWith(prisma, {
      name: "Um Dabakir",
      nameAr: "أم دباكر",
      countryCode: "SD",
      countryLocationId: COUNTRY.id,
      withinLocationId: DISTRICT.id,
    });
  });

  it("without an area, uses the country that carries the code, if one does", async () => {
    const prisma = fakePrisma();
    await placeNameSuggestions(null, { name: "Kamo", countryCode: "SD" }, ctx(PLATFORM, prisma));
    expect(suggestSpy).toHaveBeenLastCalledWith(prisma, expect.objectContaining({ countryLocationId: COUNTRY.id, withinLocationId: null }));
    prisma.locations.findFirst.mockResolvedValue(null);
    await placeNameSuggestions(null, { name: "Kamo", countryCode: "SD" }, ctx(PLATFORM, prisma));
    expect(suggestSpy).toHaveBeenLastCalledWith(prisma, expect.objectContaining({ countryLocationId: null }));
  });

  it("refuses an empty name, a bad country code, an unknown area and a non-decider", async () => {
    for (const args of [
      { name: " ", countryCode: "SD" },
      { name: "Kamo", countryCode: "SDN" },
      { name: "Kamo", countryCode: "SD", withinLocationId: "no-such-location" },
    ]) {
      await expect(placeNameSuggestions(null, args, ctx(PLATFORM))).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    await expect(placeNameSuggestions(null, { name: "Kamo", countryCode: "SD" }, ctx(WORKER))).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });
});

describe("resolveGazetteerLocation: aliases first", () => {
  const PIPELINE = { id: "u-pipeline", role: "pipeline" };
  const lookup = (prisma: Fake, withinLocationId?: string) =>
    gazetteerResolvers.Query.resolveGazetteerLocation(
      undefined,
      { name: "Um-Dabākir", countryCode: "sd", withinLocationId },
      ctx(PIPELINE, prisma),
    );

  it("returns an alias as a CLEAR location with a point, and does not ask GeoNames", async () => {
    aliasSpy.mockResolvedValue({
      aliasId: "alias-1",
      locationId: "loc-l4",
      name: "Um Dabakir",
      geonamesId: null,
      latitude: 12.1,
      longitude: 30.2,
      countryCode: "SD",
    });
    const prisma = fakePrisma();
    expect(await lookup(prisma, STATE.id)).toEqual({
      geonamesId: 0,
      name: "Um Dabakir",
      latitude: 12.1,
      longitude: 30.2,
      featureClass: null,
      featureCode: null,
      countryCode: "SD",
      population: 0,
      score: 1,
      exact: true,
      locationId: "loc-l4",
      source: "ALIAS",
    });
    expect(aliasSpy).toHaveBeenCalledWith(prisma, "um dabakir", "SD", STATE.id);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("falls through to GeoNames, and marks the hit", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([
      { geonamesId: 7, name: "Um Dabakir", latitude: 12.1, longitude: 30.2, featureClass: "P", featureCode: "PPL", countryCode: "SD", population: 10n },
    ]);
    expect(await lookup(prisma)).toMatchObject({ geonamesId: 7, source: "GEONAMES", locationId: null, exact: true });
    expect(aliasSpy).toHaveBeenCalledWith(prisma, "um dabakir", "SD", null);
  });
});

describe("resolveIntoAlias", () => {
  const args = { row: ROW, locationId: DISTRICT.id, userId: "u-1", note: "n", source: "review" as const };
  const real = () => {
    resolveSpy.mockRestore();
    return placeNames.resolveIntoAlias;
  };

  it("closes the row, writes both aliases, links the alias and moves the Signals", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([{ id: "sig-1" }, { id: "sig-2" }]);
    const result = await real()(prisma as never, args);
    expect(result).toEqual({ aliasId: "alias-1", signalsMoved: 2 });
    expect(prisma.unresolvedPlaceNames.updateMany).toHaveBeenCalledWith({
      where: { id: ROW.id, status: { in: ["open", "ambiguous"] } },
      data: expect.objectContaining({ status: "resolved", resolvedById: "u-1", resolutionNote: "n" }),
    });
    expect(prisma.placeAliases.create).toHaveBeenCalledWith({
      data: {
        nameNorm: "um dabakir",
        nameDisplay: "Um Dabakir",
        countryCode: "SD",
        scopeLocationId: STATE.id,
        locationId: DISTRICT.id,
        source: "review",
        createdById: "u-1",
        note: "n",
      },
      select: { id: true },
    });
    expect(prisma.placeAliases.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ nameNorm: "ام دباكر", nameDisplay: "أم دباكر", scopeLocationId: STATE.id, locationId: DISTRICT.id })],
      skipDuplicates: true,
    });
    expect(prisma.unresolvedPlaceNames.update).toHaveBeenCalledWith({ where: { id: ROW.id }, data: { placeAliasId: "alias-1" } });
  });

  it("writes no Arabic alias for a row with none, and none at all for an alias that exists", async () => {
    const prisma = fakePrisma();
    await placeNames.resolveIntoAlias(prisma as never, { ...args, row: { ...ROW, nameAr: null } });
    expect(prisma.placeAliases.createMany).not.toHaveBeenCalled();

    const existing = fakePrisma();
    const result = await placeNames.resolveIntoAlias(existing as never, { ...args, aliasId: "alias-9", source: "manual" });
    expect(result.aliasId).toBe("alias-9");
    expect(existing.placeAliases.create).not.toHaveBeenCalled();
    expect(existing.unresolvedPlaceNames.update).toHaveBeenCalledWith({ where: { id: ROW.id }, data: { placeAliasId: "alias-9" } });
  });

  it("is a conflict when the row closed meanwhile, or the spelling has an alias", async () => {
    const closed = fakePrisma();
    closed.unresolvedPlaceNames.updateMany.mockResolvedValue({ count: 0 });
    await expect(placeNames.resolveIntoAlias(closed as never, args)).rejects.toMatchObject({ reason: "ROW_CLOSED" });
    expect(closed.placeAliases.create).not.toHaveBeenCalled();

    const taken = fakePrisma();
    taken.placeAliases.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }),
    );
    await expect(placeNames.resolveIntoAlias(taken as never, args)).rejects.toMatchObject({ reason: "ALIAS_EXISTS" });

    const broken = fakePrisma();
    broken.placeAliases.create.mockRejectedValue(new Error("db down"));
    await expect(placeNames.resolveIntoAlias(broken as never, args)).rejects.toThrow("db down");
  });
});

describe("suggestPlaces and findPlaceAlias", () => {
  it("returns nothing for a name with no letters", async () => {
    suggestSpy.mockRestore();
    const prisma = fakePrisma();
    expect(
      await placeNames.suggestPlaces(prisma as never, { name: " -- ", countryCode: "SD", countryLocationId: null, withinLocationId: null }),
    ).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("asks GeoNames, and CLEAR locations only when the country is known", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ kind: "GEONAMES", geonamesId: 7 }]).mockResolvedValueOnce([{ kind: "LOCATION", locationId: "l" }]);
    const base = { name: "Um Dabakir", nameAr: "أم دباكر", countryCode: "SD", withinLocationId: STATE.id };
    expect(await placeNames.suggestPlaces(prisma as never, { ...base, countryLocationId: COUNTRY.id })).toEqual([
      { kind: "GEONAMES", geonamesId: 7 },
      { kind: "LOCATION", locationId: "l" },
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // the trigram floor, local to the transaction

    const noCountry = fakePrisma();
    noCountry.$queryRaw.mockResolvedValueOnce([]);
    await placeNames.suggestPlaces(noCountry as never, { ...base, countryLocationId: null });
    expect(noCountry.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns the first alias row, or null", async () => {
    aliasSpy.mockRestore();
    const prisma = fakePrisma();
    expect(await placeNames.findPlaceAlias(prisma as never, "kamo", "SD", null)).toBeNull();
    prisma.$queryRaw.mockResolvedValue([{ aliasId: "a", locationId: "l" }]);
    expect(await placeNames.findPlaceAlias(prisma as never, "kamo", "SD", STATE.id)).toEqual({ aliasId: "a", locationId: "l" });
  });
});
