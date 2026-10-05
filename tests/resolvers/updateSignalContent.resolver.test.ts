/**
 * Tests for updateSignalContent — applies an in-place change (content
 * revision and/or retraction flip and/or raw blob pointer move) to an existing
 * signal, identified by id or by (sourceId, externalId).
 *
 * DB-FREE: `context.prisma` is a STATEFUL mock store shared by the resolvers
 * under test. findUnique returns a copy of the stored row (+ `_count` when
 * asked); updateMany matches where {id, revision, status} against the stored
 * row, applies `data` (incl. `{increment: n}`) and returns {count}. A hook
 * lets a test run code before updateMany to simulate a concurrent drain.
 * `createPointLocation` (the PostGIS dependency) is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

vi.mock("../../src/utils/geo-resolve.js", () => ({
  createPointLocation: vi.fn().mockResolvedValue({ id: "point-loc-1", name: "pt", level: 4 }),
  getLocationIdsWithDescendants: vi.fn().mockResolvedValue([]),
}));

import { createPointLocation } from "../../src/utils/geo-resolve.js";
import { signalResolvers, statusAfterChange } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";

const update = signalResolvers.Mutation.updateSignalContent;
const markProcessed = signalResolvers.Mutation.markSignalsProcessed;

type Row = Record<string, unknown> & { id: string; revision: number; status: string };
type Status = "NEW" | "PROCESSED" | "FAILED" | "NEEDS_RECOMPUTE";

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: "s1",
    sourceId: "src1",
    externalId: "ext1",
    contentHash: "h0",
    retracted: false,
    rawS3Key: "k0",
    revision: 3,
    status: "PROCESSED",
    lastRevisedAt: null,
    title: "old title",
    severity: 2,
    locationId: null,
    ...over,
  };
}

/** Stateful store + prisma mock. `links` = signalEvents rows per signal id. */
function makeStore(rows: Row[], links: Record<string, number> = {}) {
  const state = {
    rows: new Map<string, Row>(rows.map((r) => [r.id, { ...r }])),
    links: { ...links },
    /** Runs once, before the first updateMany applies. */
    beforeFirstUpdateMany: null as null | (() => void),
    /** Runs before EVERY updateMany. */
    beforeEachUpdateMany: null as null | (() => void),
    firstDone: false,
  };

  const findRow = (where: Record<string, unknown>): Row | undefined => {
    if (typeof where.id === "string") return state.rows.get(where.id);
    const nk = where.sourceId_externalId as { sourceId: string; externalId: string } | undefined;
    if (nk) {
      return [...state.rows.values()].find(
        (r) => r.sourceId === nk.sourceId && r.externalId === nk.externalId,
      );
    }
    return undefined;
  };

  const prisma = {
    signals: {
      findUnique: vi.fn(async (args: { where: Record<string, unknown>; include?: unknown }) => {
        const r = findRow(args.where);
        if (!r) return null;
        const copy: Record<string, unknown> = { ...r };
        if (args.include) copy._count = { signalEvents: state.links[r.id] ?? 0 };
        return copy;
      }),
      updateMany: vi.fn(
        async (args: { where: { id: string; revision?: number; status?: string }; data: Record<string, unknown> }) => {
          if (!state.firstDone) {
            state.firstDone = true;
            state.beforeFirstUpdateMany?.();
          }
          state.beforeEachUpdateMany?.();
          const r = state.rows.get(args.where.id);
          if (!r) return { count: 0 };
          if (args.where.revision !== undefined && r.revision !== args.where.revision) return { count: 0 };
          if (args.where.status !== undefined && r.status !== args.where.status) return { count: 0 };
          for (const [k, v] of Object.entries(args.data)) {
            if (v && typeof v === "object" && "increment" in (v as object)) {
              (r as Record<string, unknown>)[k] = (r[k] as number) + (v as { increment: number }).increment;
            } else if (v !== undefined) {
              (r as Record<string, unknown>)[k] = v;
            }
          }
          return { count: 1 };
        },
      ),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { state, prisma };
}

function ctx(prisma: unknown, role: string | null = "admin"): Context {
  return {
    prisma,
    user: role ? ({ id: "u", role } as unknown) : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as unknown as Context;
}

type Written = { where: { id: string; revision: number; status: string }; data: Record<string, unknown> };
const written = (prisma: ReturnType<typeof makeStore>["prisma"], n = 0) =>
  prisma.signals.updateMany.mock.calls[n][0] as unknown as Written;
const attemptReads = (prisma: ReturnType<typeof makeStore>["prisma"]) =>
  prisma.signals.findUnique.mock.calls.filter((c) => (c[0] as { include?: unknown }).include !== undefined);

beforeEach(() => {
  vi.mocked(createPointLocation).mockClear();
});

// ─── statusAfterChange ───────────────────────────────────────────────────────

describe("statusAfterChange", () => {
  it.each<[Status, boolean, Status]>([
    ["FAILED", false, "FAILED"],
    ["FAILED", true, "FAILED"],
    ["NEW", false, "NEW"],
    ["NEW", true, "NEEDS_RECOMPUTE"],
    ["PROCESSED", false, "NEW"],
    ["PROCESSED", true, "NEEDS_RECOMPUTE"],
    ["NEEDS_RECOMPUTE", false, "NEW"],
    ["NEEDS_RECOMPUTE", true, "NEEDS_RECOMPUTE"],
  ])("%s linked=%s -> %s", (cur, linked, expected) => {
    expect(statusAfterChange(cur, linked)).toBe(expected);
  });
});

// ─── Lookup (API-U-01..07) ───────────────────────────────────────────────────

describe("updateSignalContent lookup", () => {
  it("API-U-01 rejects viewer and anonymous before touching the DB; allows pipeline", async () => {
    const { prisma } = makeStore([baseRow()]);
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma, "viewer")),
    ).rejects.toThrow(/insufficient permissions/i);
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma, null)),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(prisma.signals.findUnique).not.toHaveBeenCalled();
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma, "pipeline")),
    ).resolves.toMatchObject({ id: "s1", contentHash: "h1" });
  });

  it("API-U-02 looks up by id", async () => {
    const { prisma } = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    expect(prisma.signals.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: "s1" } });
  });

  it("API-U-03 looks up by natural key (sourceId_externalId)", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    const out = await update(
      null, { input: { sourceId: "src1", externalId: "ext1", contentHash: "h1", rawData: {} } }, ctx(prisma),
    );
    expect(prisma.signals.findUnique.mock.calls[0][0]).toMatchObject({
      where: { sourceId_externalId: { sourceId: "src1", externalId: "ext1" } },
    });
    expect(out).toMatchObject({ id: "s1", contentHash: "h1" });
    expect(state.rows.get("s1")!.contentHash).toBe("h1");
    // the CAS write targets the resolved id, not the natural key
    expect(written(prisma).where.id).toBe("s1");
  });

  it("API-U-04 no key at all -> BAD_USER_INPUT, no DB call", async () => {
    const { prisma } = makeStore([baseRow()]);
    await expect(
      update(null, { input: { contentHash: "h1", rawData: {} } }, ctx(prisma)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(prisma.signals.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["lone sourceId", { sourceId: "src1" }],
    ["lone externalId", { externalId: "ext1" }],
  ])("API-U-05 %s -> BAD_USER_INPUT", async (_n, key) => {
    const { prisma } = makeStore([baseRow()]);
    await expect(
      update(null, { input: { ...key, contentHash: "h1", rawData: {} } }, ctx(prisma)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(prisma.signals.findUnique).not.toHaveBeenCalled();
  });

  it("API-U-06 PINNED: when id AND natural key are both supplied, id wins and the natural key is ignored", async () => {
    const { prisma, state } = makeStore([
      baseRow({ id: "s1", sourceId: "src1", externalId: "ext1" }),
      baseRow({ id: "s2", sourceId: "src2", externalId: "ext2" }),
    ]);
    // natural key points at s2, id points at s1: no BAD_USER_INPUT, s1 is updated.
    await update(
      null,
      { input: { id: "s1", sourceId: "src2", externalId: "ext2", contentHash: "h1", rawData: {} } },
      ctx(prisma),
    );
    expect(prisma.signals.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: "s1" } });
    expect(state.rows.get("s1")!.contentHash).toBe("h1");
    expect(state.rows.get("s2")!.contentHash).toBe("h0");
  });

  it("API-U-07 natural key not found -> NOT_FOUND", async () => {
    const { prisma } = makeStore([baseRow()]);
    await expect(
      update(null, { input: { sourceId: "x", externalId: "y", contentHash: "h1", rawData: {} } }, ctx(prisma)),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(prisma.signals.updateMany).not.toHaveBeenCalled();
  });

  it("id not found -> NOT_FOUND", async () => {
    const { prisma } = makeStore([]);
    await expect(
      update(null, { input: { id: "nope", contentHash: "h1", rawData: {} } }, ctx(prisma)),
    ).rejects.toThrow(/not found/i);
  });
});

// ─── Retraction (API-U-08..14) ───────────────────────────────────────────────

describe("updateSignalContent retraction", () => {
  it("API-U-08 retraction with unchanged hash is written; no content fields, no location resolution", async () => {
    const { prisma, state } = makeStore([baseRow()], { s1: 1 });
    const out = await update(
      null,
      { input: { id: "s1", contentHash: "h0", retracted: true, rawData: { x: 1 }, title: "NEW", lat: 1, lng: 2 } },
      ctx(prisma),
    );
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1);
    const { data } = written(prisma);
    expect(Object.keys(data).sort()).toEqual(["lastRevisedAt", "retracted", "revision", "status"]);
    expect(data.retracted).toBe(true);
    expect(data.revision).toEqual({ increment: 1 });
    expect(data.lastRevisedAt).toBeInstanceOf(Date);
    expect(data.status).toBe("NEEDS_RECOMPUTE");
    expect(createPointLocation).not.toHaveBeenCalled();
    expect(state.rows.get("s1")!.title).toBe("old title");
    expect(out).toMatchObject({ retracted: true, revision: 4 });
  });

  it("API-U-09 retracted absent -> unchanged (same hash = no write)", async () => {
    const { prisma } = makeStore([baseRow({ retracted: true })]);
    await update(null, { input: { id: "s1", contentHash: "h0", rawData: {} } }, ctx(prisma));
    expect(prisma.signals.updateMany).not.toHaveBeenCalled();
  });

  it("API-U-10 retracted: null is treated as absent", async () => {
    const same = makeStore([baseRow({ retracted: true })]);
    await update(null, { input: { id: "s1", contentHash: "h0", retracted: null, rawData: {} } }, ctx(same.prisma));
    expect(same.prisma.signals.updateMany).not.toHaveBeenCalled();

    const changed = makeStore([baseRow({ retracted: true })]);
    await update(null, { input: { id: "s1", contentHash: "h1", retracted: null, rawData: {} } }, ctx(changed.prisma));
    expect(written(changed.prisma).data).not.toHaveProperty("retracted");
    expect(changed.state.rows.get("s1")!.retracted).toBe(true);
  });

  it("API-U-11 un-retract writes retracted=false and bumps revision", async () => {
    const { prisma, state } = makeStore([baseRow({ retracted: true })], { s1: 1 });
    await update(null, { input: { id: "s1", contentHash: "h0", retracted: false, rawData: {} } }, ctx(prisma));
    expect(written(prisma).data.retracted).toBe(false);
    expect(state.rows.get("s1")).toMatchObject({ retracted: false, revision: 4, status: "NEEDS_RECOMPUTE" });
  });

  it("API-U-12 content + flag together: ONE write, revision +1 (not +2)", async () => {
    const { prisma, state } = makeStore([baseRow()], { s1: 1 });
    await update(
      null, { input: { id: "s1", contentHash: "h1", retracted: true, rawData: { a: 1 }, title: "t2" } }, ctx(prisma),
    );
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1);
    const { data } = written(prisma);
    expect(data).toMatchObject({ retracted: true, contentHash: "h1", title: "t2", revision: { increment: 1 } });
    expect(state.rows.get("s1")!.revision).toBe(4);
  });

  it.each([false, true])("API-U-13 same flag (%s) and same hash -> no write", async (flag) => {
    const { prisma } = makeStore([baseRow({ retracted: flag })]);
    const out = await update(null, { input: { id: "s1", contentHash: "h0", retracted: flag, rawData: {} } }, ctx(prisma));
    expect(prisma.signals.updateMany).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: "s1", revision: 3 });
  });

  it("API-U-14 no-op resend returns the stored row with one read and no write", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    const before = JSON.stringify(state.rows.get("s1"));
    const out = await update(
      null, { input: { id: "s1", contentHash: "h0", retracted: false, rawS3Key: "k0", rawData: { z: 1 } } }, ctx(prisma),
    );
    expect(prisma.signals.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.signals.updateMany).not.toHaveBeenCalled();
    expect(out).toMatchObject({ id: "s1", contentHash: "h0" });
    expect(JSON.stringify(state.rows.get("s1"))).toBe(before);
  });
});

// ─── Seed and revision stamps (API-U-15..17) ─────────────────────────────────

describe("updateSignalContent seed / revision stamps", () => {
  it("API-U-15 first hash seed bumps revision but does not stamp lastRevisedAt", async () => {
    const { prisma, state } = makeStore([baseRow({ contentHash: null, status: "NEW" })]);
    const out = await update(null, { input: { id: "s1", contentHash: "first", rawData: { a: 1 } } }, ctx(prisma));
    const { data } = written(prisma);
    expect(data.revision).toEqual({ increment: 1 });
    expect(data).not.toHaveProperty("lastRevisedAt");
    expect(data).not.toHaveProperty("status"); // NEW & unlinked stays NEW
    expect(out).toMatchObject({ contentHash: "first", revision: 4, lastRevisedAt: null, status: "NEW" });
    expect(state.rows.get("s1")!.lastRevisedAt).toBeNull();
  });

  it("API-U-16 seed plus retraction change DOES stamp lastRevisedAt", async () => {
    const { prisma } = makeStore([baseRow({ contentHash: null, status: "NEW" })]);
    await update(null, { input: { id: "s1", contentHash: "first", retracted: true, rawData: {} } }, ctx(prisma));
    expect(written(prisma).data.lastRevisedAt).toBeInstanceOf(Date);
  });

  it("API-U-17 a real revision (stored hash non-null) stamps lastRevisedAt and bumps revision each time", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    expect(written(prisma, 0).data.lastRevisedAt).toBeInstanceOf(Date);
    await update(null, { input: { id: "s1", contentHash: "h2", rawData: {} } }, ctx(prisma));
    expect(written(prisma, 1).data.lastRevisedAt).toBeInstanceOf(Date);
    expect(state.rows.get("s1")!.revision).toBe(5);
    expect(state.rows.get("s1")!.lastRevisedAt).toBeInstanceOf(Date);
  });

  it("seed then identical resend is gated (second call writes nothing)", async () => {
    const { prisma } = makeStore([baseRow({ contentHash: null, status: "NEW" })]);
    const c = ctx(prisma);
    await update(null, { input: { id: "s1", contentHash: "a", rawData: {}, severity: 3 } }, c);
    await update(null, { input: { id: "s1", contentHash: "a", rawData: {}, severity: 5 } }, c);
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ─── rawS3Key (API-U-18..21) ─────────────────────────────────────────────────

describe("updateSignalContent rawS3Key", () => {
  it("API-U-18 only the key changed -> data is exactly {rawS3Key}; no revision/lastRevisedAt/status", async () => {
    const { prisma, state } = makeStore([baseRow()], { s1: 1 });
    await update(null, { input: { id: "s1", contentHash: "h0", rawS3Key: "k1", rawData: {} } }, ctx(prisma));
    expect(written(prisma).data).toEqual({ rawS3Key: "k1" });
    expect(state.rows.get("s1")).toMatchObject({ rawS3Key: "k1", revision: 3, status: "PROCESSED", lastRevisedAt: null });
  });

  it("API-U-19 key + content together: both written, one revision", async () => {
    const { prisma } = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h1", rawS3Key: "k1", rawData: {} } }, ctx(prisma));
    expect(written(prisma).data).toMatchObject({ rawS3Key: "k1", contentHash: "h1", revision: { increment: 1 } });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
  ])("API-U-20 rawS3Key %s leaves the key alone", async (_n, key) => {
    const noop = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h0", rawS3Key: key, rawData: {} } }, ctx(noop.prisma));
    expect(noop.prisma.signals.updateMany).not.toHaveBeenCalled();

    const changed = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h1", rawS3Key: key, rawData: {} } }, ctx(changed.prisma));
    expect(written(changed.prisma).data).not.toHaveProperty("rawS3Key");
    expect(changed.state.rows.get("s1")!.rawS3Key).toBe("k0");
  });

  it("API-U-21 same key and same hash -> no write", async () => {
    const { prisma } = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h0", rawS3Key: "k0", rawData: {} } }, ctx(prisma));
    expect(prisma.signals.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Transition table (API-U-22..26) ─────────────────────────────────────────

describe("updateSignalContent status transitions", () => {
  const triggers = [
    ["content change", { contentHash: "h1" }],
    ["retraction-only", { contentHash: "h0", retracted: true }],
  ] as const;

  // [stored status, linked count, expected written status (undefined = key absent)]
  const table: [Status, number, Status | undefined][] = [
    ["NEW", 0, undefined],
    ["NEW", 2, "NEEDS_RECOMPUTE"],
    ["PROCESSED", 0, "NEW"],
    ["PROCESSED", 1, "NEEDS_RECOMPUTE"],
    ["NEEDS_RECOMPUTE", 1, undefined],
    ["NEEDS_RECOMPUTE", 0, "NEW"],
    ["FAILED", 0, undefined],
    ["FAILED", 1, undefined],
  ];

  describe.each(triggers)("%s", (_name, trig) => {
    it.each(table)("stored %s, %i link(s) -> %s", async (status, nLinks, expected) => {
      const { prisma, state } = makeStore([baseRow({ status, revision: 7 })], { s1: nLinks });
      await update(null, { input: { id: "s1", rawData: {}, ...trig } as never }, ctx(prisma));
      const { where, data } = written(prisma);
      expect(where).toEqual({ id: "s1", revision: 7, status });
      if (expected === undefined) {
        expect(data).not.toHaveProperty("status");
        expect(state.rows.get("s1")!.status).toBe(status);
      } else {
        expect(data.status).toBe(expected);
        expect(state.rows.get("s1")!.status).toBe(expected);
      }
      expect(data.revision).toEqual({ increment: 1 });
    });
  });
});

// ─── Revision of a PROCESSED signal (API-U-70..71) ───────────────────────────

describe("updateSignalContent revision of a PROCESSED signal", () => {
  it("API-U-70 no event links (dropped below relevance) -> NEW, so first grouping re-classifies it", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "PROCESSED" })], { s1: 0 });
    const out = await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    expect(written(prisma).data.status).toBe("NEW");
    expect(state.rows.get("s1")).toMatchObject({ status: "NEW", revision: 4, contentHash: "h1" });
    expect(out).toMatchObject({ status: "NEW" });
  });

  it("API-U-71 linked to an event -> NEEDS_RECOMPUTE, so its events are re-aggregated", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "PROCESSED" })], { s1: 1 });
    const out = await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    expect(written(prisma).data.status).toBe("NEEDS_RECOMPUTE");
    expect(state.rows.get("s1")).toMatchObject({ status: "NEEDS_RECOMPUTE", revision: 4, contentHash: "h1" });
    expect(out).toMatchObject({ status: "NEEDS_RECOMPUTE" });
  });
});

// ─── Reads (API-U-27) ────────────────────────────────────────────────────────

describe("updateSignalContent link read", () => {
  it("API-U-27 each attempt does ONE findUnique including _count.signalEvents", async () => {
    const { prisma } = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    const reads = attemptReads(prisma);
    expect(reads).toHaveLength(1);
    expect(reads[0][0]).toEqual({
      where: { id: "s1" },
      include: { _count: { select: { signalEvents: true } } },
    });
  });
});

// ─── Concurrency (API-U-28..32) ──────────────────────────────────────────────

describe("updateSignalContent concurrency", () => {
  it("API-U-28 drain marks between read and write -> retry lands on NEEDS_RECOMPUTE", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "NEW", revision: 0 })], { s1: 0 });
    state.beforeFirstUpdateMany = () => {
      // drain linked the row and marked it PROCESSED
      state.links.s1 = 1;
      state.rows.get("s1")!.status = "PROCESSED";
    };
    const out = await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));

    expect(attemptReads(prisma)).toHaveLength(2);
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(2);
    expect(written(prisma, 0).where).toEqual({ id: "s1", revision: 0, status: "NEW" });
    expect(written(prisma, 0).data).not.toHaveProperty("status");
    expect(written(prisma, 1).where).toEqual({ id: "s1", revision: 0, status: "PROCESSED" });
    expect(written(prisma, 1).data.status).toBe("NEEDS_RECOMPUTE");
    expect(state.rows.get("s1")).toMatchObject({ status: "NEEDS_RECOMPUTE", revision: 1, contentHash: "h1" });
    expect(out).toMatchObject({ status: "NEEDS_RECOMPUTE", revision: 1 });
  });

  it("API-U-29 update lands first, then the drain's markSignalsProcessed(items) with the old revision returns 0", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "NEW", revision: 2 })], { s1: 1 });
    // drain fetched the row at revision 2 (NEW, linked)
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));
    expect(state.rows.get("s1")).toMatchObject({ revision: 3, status: "NEEDS_RECOMPUTE" });

    const stale = await markProcessed(null, { items: [{ id: "s1", revision: 2 }] }, ctx(prisma));
    expect(stale).toBe(0);
    expect(state.rows.get("s1")!.status).toBe("NEEDS_RECOMPUTE"); // not clobbered to PROCESSED

    // control: the fresh revision does mark it
    const fresh = await markProcessed(null, { items: [{ id: "s1", revision: 3 }] }, ctx(prisma));
    expect(fresh).toBe(1);
    expect(state.rows.get("s1")!.status).toBe("PROCESSED");
  });

  it("API-U-30 link created before the mark: row ends NEW, linked, revision bumped, and is listed by pendingRecomputes", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "NEW", revision: 0 })], { s1: 0 });
    state.beforeFirstUpdateMany = () => {
      state.links.s1 = 1; // linked, mark not yet sent: status/revision unchanged
    };
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma));

    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1); // CAS still matches
    const row = state.rows.get("s1")!;
    expect(row).toMatchObject({ status: "NEW", revision: 1 });
    expect(state.links.s1).toBe(1);

    // pendingRecomputes' where, evaluated against the store
    const findMany = vi.fn(async (args: { where: { OR: Record<string, unknown>[] } }) =>
      [...state.rows.values()].filter((r) =>
        args.where.OR.some((c) => {
          if (c.status !== r.status) return false;
          const se = c.signalEvents as { some: object } | undefined;
          return se ? (state.links[r.id] ?? 0) > 0 : true;
        }),
      ),
    );
    const listed = await signalResolvers.Query.pendingRecomputes({}, {}, ctx({ signals: { findMany } }));
    expect((listed as Row[]).map((r) => r.id)).toEqual(["s1"]);

    // and the drain's pre-update revision can no longer mark it
    expect(await markProcessed(null, { items: [{ id: "s1", revision: 0 }] }, ctx(prisma))).toBe(0);
  });

  it("API-U-31 retries exhausted -> exactly 4 updateMany then CONFLICT, content untouched", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    // a concurrent writer bumps the revision before every CAS
    state.beforeEachUpdateMany = () => {
      state.rows.get("s1")!.revision += 1;
    };
    const err = await update(null, { input: { id: "s1", contentHash: "h1", rawData: {}, title: "X" } }, ctx(prisma)).catch((e) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions.code).toBe("CONFLICT");
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(4);
    expect(attemptReads(prisma)).toHaveLength(4);
    const row = state.rows.get("s1")!;
    expect(row).toMatchObject({ contentHash: "h0", title: "old title", retracted: false, status: "PROCESSED" });
    expect(row.revision).toBe(7); // only the concurrent bumps
  });

  it("API-U-32 row deleted between attempts -> NOT_FOUND", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "NEW" })]);
    state.beforeFirstUpdateMany = () => {
      state.rows.delete("s1");
    };
    await expect(
      update(null, { input: { id: "s1", contentHash: "h1", rawData: {} } }, ctx(prisma)),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ─── Location resolution (API-U-33) and return value (API-U-34) ──────────────

describe("updateSignalContent location + return", () => {
  it("resolves a new locationId from lat/lng via createPointLocation", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    const out = await update(
      null, { input: { id: "s1", contentHash: "h1", rawData: {}, lat: 13.6, lng: 24.7 } }, ctx(prisma),
    );
    expect(createPointLocation).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ locationId: "point-loc-1" });
    expect(state.rows.get("s1")!.locationId).toBe("point-loc-1");
  });

  it("API-U-33 explicit locationId passes through without createPointLocation", async () => {
    const { prisma } = makeStore([baseRow()]);
    await update(
      null, { input: { id: "s1", contentHash: "h1", rawData: {}, locationId: "loc-9", lat: 1, lng: 2 } }, ctx(prisma),
    );
    expect(written(prisma).data.locationId).toBe("loc-9");
    expect(createPointLocation).not.toHaveBeenCalled();
  });

  it("API-U-33 not called for retraction-only, key-only, or no-op updates", async () => {
    const coords = { lat: 1, lng: 2, rawData: {} };
    const a = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h0", retracted: true, ...coords } }, ctx(a.prisma));
    const b = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h0", rawS3Key: "k9", ...coords } }, ctx(b.prisma));
    const c = makeStore([baseRow()]);
    await update(null, { input: { id: "s1", contentHash: "h0", ...coords } }, ctx(c.prisma));
    expect(createPointLocation).not.toHaveBeenCalled();
  });

  it("API-U-33 resolved at most once even when the CAS retries; the retry reuses the resolved id", async () => {
    const { prisma, state } = makeStore([baseRow({ status: "NEW", revision: 0 })], { s1: 0 });
    state.beforeFirstUpdateMany = () => {
      state.links.s1 = 1;
      state.rows.get("s1")!.status = "PROCESSED";
    };
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {}, lat: 1, lng: 2 } }, ctx(prisma));
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(2);
    expect(createPointLocation).toHaveBeenCalledTimes(1);
    expect(written(prisma, 0).data.locationId).toBe("point-loc-1");
    expect(written(prisma, 1).data.locationId).toBe("point-loc-1");
  });

  it("API-U-33 a retry that turns into a no-op (someone applied the same hash) still resolves location at most once and writes nothing more", async () => {
    const { prisma, state } = makeStore([baseRow()]);
    state.beforeFirstUpdateMany = () => {
      const r = state.rows.get("s1")!;
      r.revision += 1; // concurrent writer applied the same content
      r.contentHash = "h1";
    };
    await update(null, { input: { id: "s1", contentHash: "h1", rawData: {}, lat: 1, lng: 2 } }, ctx(prisma));
    expect(prisma.signals.updateMany).toHaveBeenCalledTimes(1);
    expect(createPointLocation).toHaveBeenCalledTimes(1);
  });

  it("API-U-34 returns the re-read row (plain findUnique by id, no _count), reflecting the write", async () => {
    const { prisma } = makeStore([baseRow()]);
    const out = await update(null, { input: { id: "s1", contentHash: "h1", rawData: {}, title: "t" } }, ctx(prisma));
    const last = prisma.signals.findUnique.mock.calls.at(-1)![0];
    expect(last).toEqual({ where: { id: "s1" } });
    expect(out).not.toHaveProperty("_count");
    expect(out).toMatchObject({ contentHash: "h1", title: "t", revision: 4 });
  });
});
