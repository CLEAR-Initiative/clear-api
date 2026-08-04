/**
 * Unit tests for the groundSources admin CRUD in `ground.resolver.ts`:
 * createGroundSource (V2: admin-only + required consent record for group
 * kinds), updateGroundSource (partial, merged-row validation, immutable
 * transportId), and setGroundSourceActive (kill switch, exempt from
 * consent validation).
 *
 * DB-FREE: stubbed prisma delegates, mocked externals (same setup as
 * ground.resolver.test.ts). Fixtures synthetic.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "../../src/context.js";
import { missingConsentFields } from "../../src/services/ground-sources.js";

vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrls: vi.fn(async () => []),
  uploadBufferToS3: vi.fn(),
}));

vi.mock("../../src/resolvers/signal.resolver.js", () => ({
  signalResolvers: { Mutation: { createSignal: vi.fn() } },
}));

import { groundResolvers } from "../../src/resolvers/ground.resolver.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const ADMIN: User = { id: "admin1", role: "admin" };
const ANALYST: User = { id: "a1", role: "analyst" };

const { createGroundSource, updateGroundSource, setGroundSourceActive } =
  groundResolvers.Mutation;

const VALID_GROUP_INPUT = {
  name: "Synthetic Staff Group",
  kind: "staff_group",
  transportId: "111000111@g.us",
  consentScope: "full message content",
  consentRecordedAt: "2026-08-01T00:00:00Z",
  consentRecordedBy: "Synthetic Facilitator",
};

function sourcesPrisma(existing: Record<string, unknown> | null = null) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "gs_new",
    ...args.data,
  }));
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...(existing ?? {}),
    ...args.data,
  }));
  const prisma = {
    groundSources: {
      create,
      update,
      findUnique: vi.fn(async () => existing),
    },
  };
  return { prisma, create, update };
}

// ---------------------------------------------------------------------------
// missingConsentFields (pure policy helper)
// ---------------------------------------------------------------------------

describe("missingConsentFields", () => {
  const full = {
    consentScope: "full message content",
    consentRecordedAt: new Date("2026-08-01"),
    consentRecordedBy: "Facilitator",
  };

  it("requires nothing for the hotline kind", () => {
    expect(
      missingConsentFields("hotline", {
        consentScope: null,
        consentRecordedAt: null,
        consentRecordedBy: null,
      }),
    ).toEqual([]);
  });

  it.each(["staff_group", "partner_group"])(
    "passes a complete record for %s",
    (kind) => {
      expect(missingConsentFields(kind, full)).toEqual([]);
    },
  );

  it("names every missing field", () => {
    expect(
      missingConsentFields("staff_group", {
        consentScope: null,
        consentRecordedAt: null,
        consentRecordedBy: null,
      }),
    ).toEqual(["consentScope", "consentRecordedAt", "consentRecordedBy"]);
  });

  it("treats whitespace-only text as missing", () => {
    expect(
      missingConsentFields("partner_group", { ...full, consentScope: "   " }),
    ).toEqual(["consentScope"]);
  });
});

// ---------------------------------------------------------------------------
// Auth gate — CRUD is admin-only (analysts keep read + review, not CRUD).
// ---------------------------------------------------------------------------

describe("groundSources CRUD auth gate", () => {
  const cases: Array<{ name: string; run: (ctx: Context) => unknown }> = [
    {
      name: "createGroundSource",
      run: (ctx) => createGroundSource(null, { input: VALID_GROUP_INPUT }, ctx),
    },
    {
      name: "updateGroundSource",
      run: (ctx) => updateGroundSource(null, { id: "gs_1", input: {} }, ctx),
    },
    {
      name: "setGroundSourceActive",
      run: (ctx) => setGroundSourceActive(null, { id: "gs_1", isActive: false }, ctx),
    },
  ];

  for (const { name, run } of cases) {
    it(`${name} rejects an analyst with FORBIDDEN`, async () => {
      await expect(run(buildContext(ANALYST))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// createGroundSource
// ---------------------------------------------------------------------------

describe("createGroundSource", () => {
  it("rejects an unknown kind", async () => {
    const { prisma } = sourcesPrisma();
    await expect(
      createGroundSource(
        null,
        { input: { ...VALID_GROUP_INPUT, kind: "fan_club" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it.each([
    ["consentScope", { consentScope: null }],
    ["consentRecordedAt", { consentRecordedAt: null }],
    ["consentRecordedBy", { consentRecordedBy: null }],
  ] as const)(
    "rejects a group kind missing %s, naming the field",
    async (field, overrides) => {
      const { prisma, create } = sourcesPrisma();
      await expect(
        createGroundSource(
          null,
          { input: { ...VALID_GROUP_INPUT, ...overrides } },
          buildContext(ADMIN, prisma),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining(field),
        extensions: { code: "BAD_USER_INPUT" },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("rejects an unparseable consentRecordedAt with BAD_USER_INPUT, not a Prisma error", async () => {
    const { prisma, create } = sourcesPrisma();
    await expect(
      createGroundSource(
        null,
        { input: { ...VALID_GROUP_INPUT, consentRecordedAt: "not-a-date" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("consentRecordedAt"),
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a group source with a complete consent record", async () => {
    const { prisma, create } = sourcesPrisma();
    const result = await createGroundSource(
      null,
      { input: VALID_GROUP_INPUT },
      buildContext(ADMIN, prisma),
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Synthetic Staff Group",
        kind: "staff_group",
        transportId: "111000111@g.us",
        consentScope: "full message content",
        consentRecordedAt: new Date("2026-08-01T00:00:00Z"),
        consentRecordedBy: "Synthetic Facilitator",
        privacyDefault: "private",
      }),
    });
    expect((result as { id: string }).id).toBe("gs_new");
  });

  it("allows a hotline source without consent fields", async () => {
    const { prisma, create } = sourcesPrisma();
    await createGroundSource(
      null,
      {
        input: {
          name: "Synthetic Hotline",
          kind: "hotline",
          transportId: "+000000000000",
        },
      },
      buildContext(ADMIN, prisma),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// updateGroundSource
// ---------------------------------------------------------------------------

describe("updateGroundSource", () => {
  const EXISTING = {
    id: "gs_1",
    name: "Existing Group",
    kind: "staff_group",
    transportId: "111000111@g.us",
    consentScope: "links and resources only",
    consentRecordedAt: new Date("2026-05-01T00:00:00Z"),
    consentRecordedBy: "Original Facilitator",
    privacyDefault: "private",
    reviewerRoles: ["admin", "analyst"],
    retentionRule: null,
    isActive: true,
  };

  it("NOT_FOUND for an unknown id", async () => {
    const { prisma } = sourcesPrisma(null);
    await expect(
      updateGroundSource(
        null,
        { id: "ghost", input: { name: "x" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("merges partial input and leaves omitted fields unchanged", async () => {
    const { prisma, update } = sourcesPrisma(EXISTING);
    await updateGroundSource(
      null,
      {
        id: "gs_1",
        input: {
          consentScope: "full message content",
          consentRecordedAt: "2026-08-02T00:00:00Z",
          consentRecordedBy: "New Facilitator",
        },
      },
      buildContext(ADMIN, prisma),
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "gs_1" },
      data: {
        kind: "staff_group",
        consentScope: "full message content",
        consentRecordedAt: new Date("2026-08-02T00:00:00Z"),
        consentRecordedBy: "New Facilitator",
      },
    });
  });

  it("rejects an unparseable consentRecordedAt with BAD_USER_INPUT, not a Prisma error", async () => {
    const { prisma, update } = sourcesPrisma(EXISTING);
    await expect(
      updateGroundSource(
        null,
        { id: "gs_1", input: { consentRecordedAt: "2026-13-99 not a date" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("consentRecordedAt"),
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("re-validates the merged row: a legacy group row without consent cannot be renamed without supplying it", async () => {
    const { prisma, update } = sourcesPrisma({
      ...EXISTING,
      consentScope: null,
      consentRecordedAt: null,
      consentRecordedBy: null,
    });

    await expect(
      updateGroundSource(
        null,
        { id: "gs_1", input: { name: "Renamed" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("consentScope"),
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind on update", async () => {
    const { prisma } = sourcesPrisma(EXISTING);
    await expect(
      updateGroundSource(
        null,
        { id: "gs_1", input: { kind: "fan_club" } },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("does not expose transportId as an updatable field", async () => {
    const { prisma, update } = sourcesPrisma(EXISTING);
    await updateGroundSource(
      null,
      { id: "gs_1", input: { name: "Renamed" } },
      buildContext(ADMIN, prisma),
    );
    const data = update.mock.calls[0]![0].data;
    expect(Object.keys(data)).not.toContain("transportId");
  });
});

// ---------------------------------------------------------------------------
// setGroundSourceActive
// ---------------------------------------------------------------------------

describe("setGroundSourceActive", () => {
  it("deactivates a source even when its consent record is incomplete", async () => {
    const { prisma, update } = sourcesPrisma({
      id: "gs_1",
      kind: "staff_group",
      consentScope: null,
      consentRecordedAt: null,
      consentRecordedBy: null,
      isActive: true,
    });

    await setGroundSourceActive(
      null,
      { id: "gs_1", isActive: false },
      buildContext(ADMIN, prisma),
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "gs_1" },
      data: { isActive: false },
    });
  });

  it("NOT_FOUND for an unknown id", async () => {
    const { prisma } = sourcesPrisma(null);
    await expect(
      setGroundSourceActive(
        null,
        { id: "ghost", isActive: false },
        buildContext(ADMIN, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
