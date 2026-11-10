/**
 * Unit tests for the place alias API, DB-free: the guard against a write on
 * an alias that changed since it was read, and the lookup of a country's
 * location by its code. The rest is covered against the real schema by
 * `placeAlias.db.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/location-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/location-scope.js")>()),
  getTeamScopeLocationIds: vi.fn(),
}));
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { placeAliasResolvers } from "../../src/resolvers/placeAlias.resolver.js";
import { aliasCoversState, countryLocationIdForCode } from "../../src/services/place-names.js";
import { logActivity } from "../../src/utils/activity-log.js";
import type { Context } from "../../src/context.js";

const { updatePlaceAlias, deletePlaceAlias } = placeAliasResolvers.Mutation;

type Fn = ReturnType<typeof vi.fn>;
const PLATFORM = { id: "u-platform", role: "admin" };
const READ_AT = new Date("2026-11-10T10:00:00.000Z");
const ALIAS = {
  id: "alias-1",
  nameNorm: "um dabakir",
  nameDisplay: "Um Dabakir",
  countryCode: "SD",
  scopeLocationId: "loc-state",
  locationId: "loc-district",
  source: "manual",
  note: null,
  updatedAt: READ_AT,
};

interface Fake {
  placeAliases: { findUnique: Fn; findUniqueOrThrow: Fn; updateMany: Fn; deleteMany: Fn };
  unresolvedPlaceNames: { updateMany: Fn };
  $transaction: Fn;
}

function fakePrisma(): Fake {
  const prisma: Fake = {
    placeAliases: {
      findUnique: vi.fn().mockResolvedValue(ALIAS),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ALIAS, note: "Checked" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    unresolvedPlaceNames: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: Fake) => unknown) => fn(prisma));
  return prisma;
}

const ctx = (prisma: Fake): Context =>
  ({ prisma, user: PLATFORM, session: null, authMethod: "session", locale: "en", signalScope: { kind: "full" } }) as unknown as Context;

beforeEach(() => vi.mocked(logActivity).mockClear());

describe("a write on an alias that changed since it was read", () => {
  it("an update writes only what the request changes, against the version it read", async () => {
    const prisma = fakePrisma();
    const updated = await updatePlaceAlias(null, { id: ALIAS.id, input: { note: " Checked " } }, ctx(prisma));
    expect(prisma.placeAliases.updateMany).toHaveBeenCalledWith({
      where: { id: ALIAS.id, updatedAt: READ_AT },
      // No scope, no target: a note-only edit cannot undo another person's change.
      data: { note: "Checked" },
    });
    expect(updated).toMatchObject({ note: "Checked", canEdit: true });
    expect(prisma.unresolvedPlaceNames.updateMany).not.toHaveBeenCalled();
  });

  it("an update of a changed alias is a conflict, and nothing is logged", async () => {
    const prisma = fakePrisma();
    prisma.placeAliases.updateMany.mockResolvedValue({ count: 0 });
    await expect(updatePlaceAlias(null, { id: ALIAS.id, input: { note: "x" } }, ctx(prisma))).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    expect(prisma.placeAliases.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("a delete removes the alias as it was read, and reopens its rows", async () => {
    const prisma = fakePrisma();
    expect(await deletePlaceAlias(null, { id: ALIAS.id }, ctx(prisma))).toBe(true);
    expect(prisma.placeAliases.deleteMany).toHaveBeenCalledWith({ where: { id: ALIAS.id, updatedAt: READ_AT } });
    expect(logActivity).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: "place_alias.delete", metadata: expect.objectContaining({ rowsReopened: 2 }) }),
    );
  });

  it("a delete of a changed alias is a conflict", async () => {
    const prisma = fakePrisma();
    prisma.placeAliases.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deletePlaceAlias(null, { id: ALIAS.id }, ctx(prisma))).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe("countryLocationIdForCode", () => {
  const lookup = (countries: { id: string; name: string; pCode: string | null }[], code: string) =>
    countryLocationIdForCode({ locations: { findMany: vi.fn().mockResolvedValue(countries) } } as never, code);

  it("finds a country by its pcode", async () => {
    expect(await lookup([{ id: "c-sd", name: "Republic of the Sudan", pCode: "sd" }], "SD")).toBe("c-sd");
  });

  it("finds a pipeline country with no pcode by its name", async () => {
    // As `ensureCountryLocation` and the seed create them.
    expect(await lookup([{ id: "c-sd", name: "Sudan", pCode: null }], "sd")).toBe("c-sd");
    expect(await lookup([{ id: "c-ve", name: "Venezuela (Bolivarian Republic of)", pCode: null }], "VE")).toBe("c-ve");
  });

  it("never takes a location that carries another country's code, or a country CLEAR does not know", async () => {
    expect(await lookup([{ id: "c-x", name: "Sudan", pCode: "SS" }], "SD")).toBeNull();
    expect(await lookup([{ id: "c-sd", name: "Sudan", pCode: null }], "ZZ")).toBeNull();
    expect(await lookup([], "SD")).toBeNull();
  });
});

describe("aliasCoversState", () => {
  it("a country-wide alias covers every state; a scoped one, its own", () => {
    expect(aliasCoversState(null, "s1")).toBe(true);
    expect(aliasCoversState(null, null)).toBe(true);
    expect(aliasCoversState("s1", "s1")).toBe(true);
    expect(aliasCoversState("s1", "s2")).toBe(false);
    expect(aliasCoversState("s1", null)).toBe(false);
  });
});
