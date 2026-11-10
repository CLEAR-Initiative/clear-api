/**
 * Unit tests for `unresolvedPlaceName.resolver.ts` and
 * `utils/place-name-access.ts`, DB-free.
 *
 * `context.prisma.*` is stubbed with `vi.fn()` delegates. They cover who may
 * record and who may read, input checks, the state derived from the area,
 * the scope a team admin reads, and the field resolvers. The SQL itself is
 * covered by `unresolvedPlaceName.db.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/location-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/location-scope.js")>()),
  getTeamScopeLocationIds: vi.fn(),
}));

import {
  normalizeCountryCode,
  stateOfArea,
  unresolvedPlaceNameResolvers,
} from "../../src/resolvers/unresolvedPlaceName.resolver.js";
import { placeNameInScope, requirePlaceNameDecider } from "../../src/utils/place-name-access.js";
import { getTeamScopeLocationIds } from "../../src/utils/location-scope.js";
import type { Context } from "../../src/context.js";

const { recordUnresolvedPlaceName } = unresolvedPlaceNameResolvers.Mutation;
const { unresolvedPlaceNames } = unresolvedPlaceNameResolvers.Query;

type User = { id: string; role: string } | null;
type Fn = ReturnType<typeof vi.fn>;

const PIPELINE = { id: "u-pipeline", role: "pipeline" };
const PLATFORM = { id: "u-platform", role: "admin" };
const MEMBER = { id: "u-member", role: "member" };
const WORKER = { id: "u-worker", role: "worker" };
const PENDING = { id: "u-pending", role: "pending" };

const COUNTRY = { id: "loc-sd", level: 0, pCode: "SD", ancestorIds: [] };
const STATE = { id: "loc-state", level: 1, pCode: null, ancestorIds: ["loc-sd"] };
const DISTRICT = { id: "loc-district", level: 2, pCode: null, ancestorIds: ["loc-state", "loc-sd"] };
const LOCATIONS = [COUNTRY, STATE, DISTRICT];

interface Fake {
  signals: { findUnique: Fn };
  locations: { findUnique: Fn; findMany: Fn };
  teamMembers: { findMany: Fn };
  user: { findUnique: Fn };
  placeAliases: { findUnique: Fn };
  unresolvedPlaceNames: { findUnique: Fn };
  unresolvedPlaceNameSignals: { findMany: Fn };
  $queryRaw: Fn;
  $executeRaw: Fn;
  $transaction: Fn;
}

function fakePrisma(): Fake {
  const prisma: Fake = {
    signals: { findUnique: vi.fn().mockResolvedValue({ id: "sig-1", sourceId: "src-1" }) },
    locations: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(LOCATIONS.find((l) => l.id === where.id) ?? null),
      ),
      findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(LOCATIONS.filter((l) => where.id.in.includes(l.id) && l.level <= 1)),
      ),
    },
    teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue({ name: "Amal" }) },
    placeAliases: { findUnique: vi.fn().mockResolvedValue({ id: "alias-1" }) },
    unresolvedPlaceNames: { findUnique: vi.fn().mockResolvedValue({ id: "row-1", signalCount: 1 }) },
    unresolvedPlaceNameSignals: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "row-1" }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: Fake) => unknown) => fn(prisma));
  return prisma;
}

function ctx(user: User, prisma: Fake = fakePrisma(), signalScope: Context["signalScope"] = { kind: "full" }): Context {
  return { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en", signalScope } as unknown as Context;
}

/** The text of a tagged-template call to `$queryRaw` / `$executeRaw`. */
const sqlOf = (call: unknown[]) => (call[0] as { strings?: string[]; sql?: string }).strings?.join("?") ?? String(call[0]);
/** The values bound in a `$queryRaw` call, nested fragments included. */
const valuesOf = (call: unknown[]) => JSON.stringify(call);

const input = { signalId: "sig-1", name: " Um-Dabākir ", countryCode: "sd", areaLocationId: DISTRICT.id };

beforeEach(() => {
  vi.mocked(getTeamScopeLocationIds).mockReset();
});

describe("recordUnresolvedPlaceName", () => {
  it("is for the admin and pipeline roles only", async () => {
    for (const user of [MEMBER, WORKER, PENDING]) {
      const prisma = fakePrisma();
      await expect(recordUnresolvedPlaceName(null, { input }, ctx(user, prisma))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
    await expect(recordUnresolvedPlaceName(null, { input }, ctx(null))).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
    await expect(recordUnresolvedPlaceName(null, { input }, ctx(PLATFORM))).resolves.toMatchObject({ id: "row-1" });
  });

  it("writes the normalised spelling, the state of the area and the defaults", async () => {
    const prisma = fakePrisma();
    const row = await recordUnresolvedPlaceName(null, { input }, ctx(PIPELINE, prisma));
    expect(row).toMatchObject({ id: "row-1" });

    const upsert = prisma.$queryRaw.mock.calls[0]!;
    expect(sqlOf(upsert)).toContain('ON CONFLICT ("country_code", "name_norm", "state_location_id")');
    // id, nameNorm, name, nameAr, countryCode, state, country, seenAt, seenAt
    expect(upsert.slice(2, 8)).toEqual(["um dabakir", "Um-Dabākir", null, "SD", STATE.id, COUNTRY.id]);
    expect(upsert[8]).toBeInstanceOf(Date);

    const link = prisma.$executeRaw.mock.calls[0]!;
    expect(sqlOf(link)).toContain("DO NOTHING");
    expect(link.slice(1, 6)).toEqual(["row-1", "sig-1", DISTRICT.id, "Um-Dabākir", "no_match"]);
    expect(sqlOf(prisma.$executeRaw.mock.calls[1]!)).toContain('"signal_count" + 1');
  });

  it("does not raise the count when the Signal is already on the row", async () => {
    const prisma = fakePrisma();
    prisma.$executeRaw.mockResolvedValue(0);
    await recordUnresolvedPlaceName(null, { input }, ctx(PIPELINE, prisma));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("passes seenAt, the reason and the Arabic spelling through", async () => {
    const prisma = fakePrisma();
    const seenAt = new Date("2026-08-03T10:00:00.000Z");
    await recordUnresolvedPlaceName(
      null,
      { input: { ...input, nameAr: " أم دباكر ", reason: "outside_area", seenAt, areaLocationId: COUNTRY.id } },
      ctx(PIPELINE, prisma),
    );
    const upsert = prisma.$queryRaw.mock.calls[0]!;
    expect(upsert.slice(4, 10)).toEqual(["أم دباكر", "SD", null, COUNTRY.id, seenAt, seenAt]);
    expect(prisma.$executeRaw.mock.calls[0]!.slice(5, 7)).toEqual(["outside_area", seenAt]);
  });

  it("refuses bad input before it writes", async () => {
    const cases: Array<[Partial<typeof input> & { seenAt?: Date; nameAr?: string }, string]> = [
      [{ name: " -- " }, "BAD_USER_INPUT"],
      [{ name: "x".repeat(501) }, "BAD_USER_INPUT"],
      [{ nameAr: "ع".repeat(501) }, "BAD_USER_INPUT"],
      [{ countryCode: "SDN" }, "BAD_USER_INPUT"],
      [{ countryCode: "VE" }, "BAD_USER_INPUT"],
      [{ areaLocationId: "no-such-location" }, "BAD_USER_INPUT"],
      [{ seenAt: new Date("not a date") }, "BAD_USER_INPUT"],
    ];
    for (const [bad, code] of cases) {
      const prisma = fakePrisma();
      await expect(
        recordUnresolvedPlaceName(null, { input: { ...input, ...bad } }, ctx(PIPELINE, prisma)),
      ).rejects.toMatchObject({ extensions: { code } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
    const prisma = fakePrisma();
    prisma.signals.findUnique.mockResolvedValue(null);
    await expect(recordUnresolvedPlaceName(null, { input }, ctx(PIPELINE, prisma))).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
});

describe("stateOfArea and normalizeCountryCode", () => {
  it("finds the state and the country code of an area", async () => {
    const prisma = fakePrisma() as unknown as Context["prisma"];
    const inSudan = { countryLocationId: COUNTRY.id, countryCode: "SD" };
    expect(await stateOfArea(prisma, DISTRICT.id)).toEqual({ stateLocationId: STATE.id, ...inSudan });
    expect(await stateOfArea(prisma, STATE.id)).toEqual({ stateLocationId: STATE.id, ...inSudan });
    expect(await stateOfArea(prisma, COUNTRY.id)).toEqual({ stateLocationId: null, ...inSudan });
    expect(await stateOfArea(prisma, "no-such-location")).toBeNull();
  });

  it("knows the country of an area when the country carries no ISO code", async () => {
    const prisma = fakePrisma();
    prisma.locations.findUnique.mockResolvedValue({ id: "loc-bare", level: 0, pCode: null, ancestorIds: [] });
    expect(await stateOfArea(prisma as unknown as Context["prisma"], "loc-bare")).toEqual({
      stateLocationId: null,
      countryLocationId: "loc-bare",
      countryCode: null,
    });
  });

  it("accepts two letters in any case", () => {
    expect(normalizeCountryCode(" sd ")).toBe("SD");
    expect(() => normalizeCountryCode("S")).toThrow(/two-letter/);
  });
});

describe("requirePlaceNameDecider", () => {
  it("gives a platform admin every row", async () => {
    expect((await requirePlaceNameDecider(ctx(PLATFORM))).scope).toEqual({ kind: "all" });
  });

  it("refuses a worker, a pending user, the pipeline and a member who administers no team", async () => {
    for (const user of [WORKER, PENDING, PIPELINE, MEMBER]) {
      await expect(requirePlaceNameDecider(ctx(user))).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
  });

  it("gives a team admin the union of their teams' areas", async () => {
    const prisma = fakePrisma();
    prisma.teamMembers.findMany.mockResolvedValue([{ teamId: "t1" }, { teamId: "t2" }]);
    vi.mocked(getTeamScopeLocationIds).mockImplementation(async (_p, teamId) =>
      teamId === "t1" ? [STATE.id, DISTRICT.id] : [COUNTRY.id],
    );
    const { scope } = await requirePlaceNameDecider(ctx(MEMBER, prisma));
    expect(scope).toEqual({ kind: "area", locationIds: new Set([STATE.id, DISTRICT.id, COUNTRY.id]) });
    expect(prisma.teamMembers.findMany).toHaveBeenCalledWith({
      where: { userId: MEMBER.id, role: "team_admin" },
      select: { teamId: true },
    });
    const row = (stateLocationId: string | null, countryLocationId: string | null) => ({ stateLocationId, countryLocationId });
    expect(placeNameInScope(scope, row(STATE.id, COUNTRY.id))).toBe(true);
    // A state outside the area, even inside a country the team covers elsewhere.
    expect(placeNameInScope(scope, row("loc-other", "loc-other-country"))).toBe(false);
    // A row with no state belongs to its country.
    expect(placeNameInScope(scope, row(null, COUNTRY.id))).toBe(true);
    expect(placeNameInScope(scope, row(null, "loc-other-country"))).toBe(false);
    expect(placeNameInScope(scope, row(null, null))).toBe(false);
    expect(placeNameInScope({ kind: "all" }, row(null, null))).toBe(true);
  });

  it("gives the admin of a team with no scope every row", async () => {
    const prisma = fakePrisma();
    prisma.teamMembers.findMany.mockResolvedValue([{ teamId: "t1" }]);
    vi.mocked(getTeamScopeLocationIds).mockResolvedValue(undefined);
    expect((await requirePlaceNameDecider(ctx(MEMBER, prisma))).scope).toEqual({ kind: "all" });
  });
});

describe("unresolvedPlaceNames", () => {
  const rows = [{ id: "row-1" }, { id: "row-2" }];
  function queuePrisma(total: number): Fake {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ count: BigInt(total) }]);
    return prisma;
  }

  it("returns a page with the total and hasMore", async () => {
    const prisma = queuePrisma(5);
    const page = await unresolvedPlaceNames(null, { first: 2 }, ctx(PLATFORM, prisma));
    expect(page).toEqual({ items: rows, totalCount: 5, hasMore: true });
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]!)).toContain(`(u."status" = 'open') DESC, u."signal_count" DESC`);
    const last = await unresolvedPlaceNames(null, { first: 2, offset: 3 }, ctx(PLATFORM, queuePrisma(5)));
    expect(last.hasMore).toBe(false);
  });

  it("adds no area filter for a platform admin", async () => {
    const prisma = queuePrisma(2);
    await unresolvedPlaceNames(null, {}, ctx(PLATFORM, prisma));
    expect(valuesOf(prisma.$queryRaw.mock.calls[0]!)).not.toContain("ANY(");
  });

  it("filters a team admin to their area, and by status, country and area", async () => {
    const prisma = queuePrisma(2);
    prisma.teamMembers.findMany.mockResolvedValue([{ teamId: "t1" }]);
    vi.mocked(getTeamScopeLocationIds).mockResolvedValue([STATE.id]);
    await unresolvedPlaceNames(
      null,
      { status: "open", countryCode: "sd", areaLocationId: DISTRICT.id },
      ctx(MEMBER, prisma),
    );
    const bound = valuesOf(prisma.$queryRaw.mock.calls[0]!);
    expect(bound).toContain('COALESCE(u.\\"state_location_id\\", u.\\"country_location_id\\") = ANY(');
    expect(bound).toContain('u.\\"status\\" = ');
    expect(bound).toContain('"open"');
    expect(bound).toContain('"SD"');
    expect(bound).toContain(`"${STATE.id}"`);
  });

  it("keeps a country's rows by its location id, and nothing for an area with no country", async () => {
    const byCountry = queuePrisma(0);
    await unresolvedPlaceNames(null, { areaLocationId: COUNTRY.id }, ctx(PLATFORM, byCountry));
    const bound = valuesOf(byCountry.$queryRaw.mock.calls[0]!);
    expect(bound).toContain('u.\\"country_location_id\\" = ');
    expect(bound).toContain(`"${COUNTRY.id}"`);

    const orphan = queuePrisma(0);
    orphan.locations.findUnique.mockResolvedValue({ id: "loc-x", level: 4, pCode: null, ancestorIds: [] });
    await unresolvedPlaceNames(null, { areaLocationId: "loc-x" }, ctx(PLATFORM, orphan));
    expect(valuesOf(orphan.$queryRaw.mock.calls[0]!)).toContain("FALSE");
  });

  it("refuses bad paging and an unknown area", async () => {
    for (const args of [{ first: 0 }, { first: 201 }, { first: 1.5 }, { offset: -1 }, { areaLocationId: "no-such-location" }]) {
      await expect(unresolvedPlaceNames(null, args, ctx(PLATFORM))).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
  });

  it("is forbidden for a member who administers no team, a worker and the pipeline", async () => {
    for (const user of [MEMBER, WORKER, PIPELINE]) {
      await expect(unresolvedPlaceNames(null, {}, ctx(user))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    }
  });
});

describe("field resolvers", () => {
  const { UnresolvedPlaceName, UnresolvedPlaceNameSignal, PlaceAlias } = unresolvedPlaceNameResolvers;

  it("maps the API enums to the stored values", () => {
    expect(unresolvedPlaceNameResolvers.UnresolvedPlaceNameStatus.NOT_A_PLACE).toBe("not_a_place");
    expect(unresolvedPlaceNameResolvers.UnresolvedPlaceNameReason.OUTSIDE_AREA).toBe("outside_area");
    expect(unresolvedPlaceNameResolvers.PlaceAliasSource.REVIEW).toBe("review");
  });

  it("loads a row's state, alias, resolver name and Signals", async () => {
    const prisma = fakePrisma();
    const context = ctx(PLATFORM, prisma);
    const row = { id: "row-1", stateLocationId: STATE.id, placeAliasId: "alias-1", resolvedById: "u-1" };
    expect(await UnresolvedPlaceName.stateLocation(row, null, context)).toMatchObject({ id: STATE.id });
    expect(await UnresolvedPlaceName.placeAlias(row, null, context)).toEqual({ id: "alias-1" });
    expect(await UnresolvedPlaceName.resolvedByName(row, null, context)).toBe("Amal");
    await UnresolvedPlaceName.signals(row, {}, context);
    expect(prisma.unresolvedPlaceNameSignals.findMany).toHaveBeenCalledWith({
      where: { unresolvedPlaceNameId: "row-1" },
      orderBy: [{ seenAt: "desc" }, { signalId: "asc" }],
      take: 5,
    });
    expect(() => UnresolvedPlaceName.signals(row, { first: 51 }, context)).toThrow(/between 1 and 50/);

    const empty = { id: "row-2", stateLocationId: null, placeAliasId: null, resolvedById: null };
    expect(UnresolvedPlaceName.stateLocation(empty, null, context)).toBeNull();
    expect(UnresolvedPlaceName.placeAlias(empty, null, context)).toBeNull();
    expect(await UnresolvedPlaceName.resolvedByName(empty, null, context)).toBeNull();
  });

  it("hides a Signal the caller may not read", async () => {
    const link = { signalId: "sig-1", areaLocationId: DISTRICT.id };
    expect(await UnresolvedPlaceNameSignal.signal(link, null, ctx(PLATFORM))).toMatchObject({ id: "sig-1" });
    const restricted = ctx(MEMBER, fakePrisma(), { kind: "restricted", sourceIds: ["src-other"] });
    expect(await UnresolvedPlaceNameSignal.signal(link, null, restricted)).toBeNull();
    expect(await UnresolvedPlaceNameSignal.areaLocation(link, null, ctx(PLATFORM))).toMatchObject({ id: DISTRICT.id });
    expect(UnresolvedPlaceNameSignal.areaLocation({ areaLocationId: null }, null, ctx(PLATFORM))).toBeNull();
  });

  it("loads an alias's location, scope and author", async () => {
    const context = ctx(PLATFORM);
    const alias = { locationId: DISTRICT.id, scopeLocationId: STATE.id, createdById: "u-1" };
    expect(await PlaceAlias.location(alias, null, context)).toMatchObject({ id: DISTRICT.id });
    expect(await PlaceAlias.scopeLocation(alias, null, context)).toMatchObject({ id: STATE.id });
    expect(await PlaceAlias.createdByName(alias, null, context)).toBe("Amal");
    expect(PlaceAlias.scopeLocation({ scopeLocationId: null }, null, context)).toBeNull();
    expect(await PlaceAlias.createdByName({ createdById: null }, null, context)).toBeNull();
  });
});
