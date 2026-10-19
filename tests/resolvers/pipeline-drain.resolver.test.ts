/**
 * Unit tests (mocked Prisma) for the Dagster drain markers added in ticket #467:
 *   A. Signal  — pendingSignals / markSignalsProcessed
 *   B. Crisis  — pendingCrises / markCrisisEnriched
 *   C. Translation — pendingTranslations / enqueueTranslation / markTranslated
 *
 * These mock `context.prisma` so they run without a database — they assert the
 * resolver logic (auth, clamping, status filters, idempotency, validation),
 * not the SQL. The DB-backed behaviour is exercised by the full suite once the
 * `20260813000000_add_pipeline_status_markers` migration is applied.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { crisisResolvers } from "../../src/resolvers/crisis.resolver.js";
import { translationResolvers } from "../../src/resolvers/translation.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";

function ctx(prisma: unknown, role: string | null = "admin"): Context {
  return {
    prisma,
    user: role ? ({ id: "u1", role } as unknown) : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as Context;
}

// ─── A. Signal ───────────────────────────────────────────────────────────────

describe("pendingSignals", () => {
  it("filters status=NEW oldest-first and clamps `first` to [1, 500]", async () => {
    const findMany = vi.fn(async () => []);
    const context = ctx({ signals: { findMany } });

    await signalResolvers.Query.pendingSignals({}, { first: 9999, source: "dataminr" }, context);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "NEW", retracted: false, signalEvents: { none: {} },
        isDummy: false, source: { name: "dataminr" },
      },
      orderBy: { publishedAt: "asc" },
      take: 500, // clamped down from 9999
    });
  });

  it("defaults `first` to 100 and omits the source filter when absent", async () => {
    const findMany = vi.fn(async () => []);
    await signalResolvers.Query.pendingSignals({}, {}, ctx({ signals: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "NEW", retracted: false, signalEvents: { none: {} }, isDummy: false },
      orderBy: { publishedAt: "asc" },
      take: 100,
    });
  });

  it("rejects a viewer (admin/pipeline only)", async () => {
    const findMany = vi.fn();
    await expect(
      signalResolvers.Query.pendingSignals({}, {}, ctx({ signals: { findMany } }, "viewer")),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts a pipeline-role user", async () => {
    const findMany = vi.fn(async () => []);
    await signalResolvers.Query.pendingSignals({}, {}, ctx({ signals: { findMany } }, "pipeline"));
    expect(findMany).toHaveBeenCalled();
  });
});

describe("markSignalsProcessed", () => {
  it("marks PROCESSED with processedAt and returns the updated count", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const context = ctx({ signals: { updateMany } });

    const n = await signalResolvers.Mutation.markSignalsProcessed({}, { ids: ["a", "b"] }, context);

    expect(n).toBe(2);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ["a", "b"] } });
    expect(call.data.status).toBe("PROCESSED");
    expect(call.data.processedAt).toBeInstanceOf(Date);
  });

  it("honours an explicit FAILED status", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await signalResolvers.Mutation.markSignalsProcessed(
      {}, { ids: ["x"], status: "FAILED" }, ctx({ signals: { updateMany } }),
    );
    expect(updateMany.mock.calls[0][0].data.status).toBe("FAILED");
  });

  it("short-circuits on an empty id list without touching the DB", async () => {
    const updateMany = vi.fn();
    const n = await signalResolvers.Mutation.markSignalsProcessed({}, { ids: [] }, ctx({ signals: { updateMany } }));
    expect(n).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects status=NEW (would produce a NEW row with a processedAt)", async () => {
    const updateMany = vi.fn();
    await expect(
      signalResolvers.Mutation.markSignalsProcessed(
        {}, { ids: ["a"], status: "NEW" }, ctx({ signals: { updateMany } }),
      ),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a pipeline-role user", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await signalResolvers.Mutation.markSignalsProcessed(
      {}, { ids: ["a"] }, ctx({ signals: { updateMany } }, "pipeline"),
    );
    expect(updateMany).toHaveBeenCalled();
  });

  it("rejects a viewer (admin/pipeline only)", async () => {
    const updateMany = vi.fn();
    await expect(
      signalResolvers.Mutation.markSignalsProcessed({}, { ids: ["a"] }, ctx({ signals: { updateMany } }, "viewer")),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects status=NEEDS_RECOMPUTE as a mark target (API-U-46)", async () => {
    const updateMany = vi.fn();
    const $transaction = vi.fn();
    const p = { signals: { updateMany }, $transaction };
    await expect(
      signalResolvers.Mutation.markSignalsProcessed({}, { ids: ["a"], status: "NEEDS_RECOMPUTE" }, ctx(p)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      signalResolvers.Mutation.markSignalsProcessed(
        {}, { items: [{ id: "a", revision: 1 }], status: "NEEDS_RECOMPUTE" }, ctx(p),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(updateMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});

// ─── A1b. markSignalsProcessed(items) — compare-and-set ─────────────────────

function itemsPrisma(counts: number[]) {
  const updateMany = vi.fn((_args: unknown) => ({ __op: true, count: counts[updateMany.mock.calls.length - 1] ?? 0 }));
  const $transaction = vi.fn(async (ops: { count: number }[]) => ops.map((o) => ({ count: o.count })));
  return { signals: { updateMany }, $transaction };
}

describe("markSignalsProcessed items (CAS)", () => {
  const mark = signalResolvers.Mutation.markSignalsProcessed;

  it("runs one $transaction with a per-item where {id, revision} and sums counts (API-U-41)", async () => {
    const p = itemsPrisma([1, 1, 0]);
    const n = await mark(
      {}, { items: [{ id: "a", revision: 2 }, { id: "b", revision: 0 }, { id: "c", revision: 5 }] }, ctx(p),
    );
    expect(n).toBe(2);
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(p.$transaction.mock.calls[0][0]).toHaveLength(3);
    expect(p.signals.updateMany).toHaveBeenCalledTimes(3);
    const calls = p.signals.updateMany.mock.calls.map((c) => c[0] as { where: unknown; data: Record<string, unknown> });
    expect(calls.map((c) => c.where)).toEqual([
      { id: "a", revision: 2 }, { id: "b", revision: 0 }, { id: "c", revision: 5 },
    ]);
    for (const c of calls) {
      expect(c.data.status).toBe("PROCESSED");
      expect(c.data.processedAt).toBeInstanceOf(Date);
    }
    // the where is exactly {id, revision}: no status condition
    expect(Object.keys(calls[0].where as object).sort()).toEqual(["id", "revision"]);
  });

  it("a stale item (revision moved) is a no-op returning 0 (API-U-42)", async () => {
    const p = itemsPrisma([0]);
    expect(await mark({}, { items: [{ id: "a", revision: 1 }] }, ctx(p))).toBe(0);
  });

  it("rejects ids + items together (API-U-43)", async () => {
    const p = itemsPrisma([1]);
    await expect(
      mark({}, { ids: ["a"], items: [{ id: "a", revision: 0 }] }, ctx(p)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(p.signals.updateMany).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("rejects neither ids nor items; empty items returns 0 without a DB call (API-U-44)", async () => {
    const p = itemsPrisma([]);
    await expect(mark({}, {}, ctx(p))).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(mark({}, { ids: null, items: null }, ctx(p))).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(await mark({}, { items: [] }, ctx(p))).toBe(0);
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(p.signals.updateMany).not.toHaveBeenCalled();
  });

  it("accepts FAILED and rejects NEW for items (API-U-45)", async () => {
    const p = itemsPrisma([1]);
    await mark({}, { items: [{ id: "a", revision: 1 }], status: "FAILED" }, ctx(p));
    expect((p.signals.updateMany.mock.calls[0][0] as { data: { status: string } }).data.status).toBe("FAILED");
    const q = itemsPrisma([1]);
    await expect(
      mark({}, { items: [{ id: "a", revision: 1 }], status: "NEW" }, ctx(q)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(q.$transaction).not.toHaveBeenCalled();
  });

  it("roles: pipeline ok, viewer and anonymous rejected (API-U-47)", async () => {
    const ok = itemsPrisma([1]);
    expect(await mark({}, { items: [{ id: "a", revision: 1 }] }, ctx(ok, "pipeline"))).toBe(1);
    for (const role of ["viewer", null]) {
      const p = itemsPrisma([1]);
      await expect(mark({}, { items: [{ id: "a", revision: 1 }] }, ctx(p, role))).rejects.toBeInstanceOf(GraphQLError);
      expect(p.$transaction).not.toHaveBeenCalled();
    }
  });
});

// ─── A1c. pendingRecomputes ──────────────────────────────────────────────────

describe("pendingRecomputes", () => {
  const q = signalResolvers.Query.pendingRecomputes;
  const expectedWhere = {
    isDummy: false,
    OR: [{ status: "NEEDS_RECOMPUTE" }, { status: "NEW", signalEvents: { some: {} } }],
  };

  it("uses the exact where, a stable orderBy and defaults take to 100 (API-U-51)", async () => {
    const findMany = vi.fn(async () => []);
    await q({}, {}, ctx({ signals: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("retracted");
  });

  it.each([[9999, 500], [0, 1], [-5, 1], [7, 7], [null, 100]])("clamps first=%s to %s", async (first, take) => {
    const findMany = vi.fn(async () => []);
    await q({}, { first }, ctx({ signals: { findMany } }));
    expect(findMany.mock.calls[0][0].take).toBe(take);
  });

  it("roles: admin and pipeline ok, viewer and anonymous rejected (API-U-52)", async () => {
    for (const role of ["admin", "pipeline"]) {
      const findMany = vi.fn(async () => []);
      await q({}, {}, ctx({ signals: { findMany } }, role));
      expect(findMany).toHaveBeenCalled();
    }
    for (const role of ["viewer", null]) {
      const findMany = vi.fn();
      await expect(q({}, {}, ctx({ signals: { findMany } }, role))).rejects.toBeInstanceOf(GraphQLError);
      expect(findMany).not.toHaveBeenCalled();
    }
  });
});

describe("pendingSignals (extra)", () => {
  it("clamps first to [1, 500] and rejects anonymous (API-U-50/52)", async () => {
    const findMany = vi.fn(async () => []);
    await signalResolvers.Query.pendingSignals({}, { first: 0 }, ctx({ signals: { findMany } }));
    expect(findMany.mock.calls[0][0].take).toBe(1);
    await expect(
      signalResolvers.Query.pendingSignals({}, {}, ctx({ signals: { findMany } }, null)),
    ).rejects.toBeInstanceOf(GraphQLError);
  });
});

// ─── A2. Event (alert-stage queue) ───────────────────────────────────────────

describe("eventsPendingAlert", () => {
  it("filters severity>=minSeverity + no-alert oldest-first and clamps `first` to [1, 500]", async () => {
    const findMany = vi.fn(async () => []);
    const context = ctx({ events: { findMany } });

    await eventResolvers.Query.eventsPendingAlert({}, { first: 9999, minSeverity: 3 }, context);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        severity: { gte: 3 },
        alerts: { none: {} },
        isDummy: false,
        lastSignalCreatedAt: { gte: expect.any(Date) }, // 48h age bound (default)
      },
      orderBy: { firstSignalCreatedAt: "asc" },
      take: 500, // clamped down from 9999
    });
  });

  it("defaults minSeverity to 4 and `first` to 100 and applies the 48h age bound", async () => {
    const findMany = vi.fn(async () => []);
    await eventResolvers.Query.eventsPendingAlert({}, {}, ctx({ events: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({
      where: {
        severity: { gte: 4 },
        alerts: { none: {} },
        isDummy: false,
        lastSignalCreatedAt: { gte: expect.any(Date) },
      },
      orderBy: { firstSignalCreatedAt: "asc" },
      take: 100,
    });
  });

  it("omits the age bound when maxAgeHours is 0", async () => {
    const findMany = vi.fn(async () => []);
    await eventResolvers.Query.eventsPendingAlert({}, { maxAgeHours: 0 }, ctx({ events: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({
      where: { severity: { gte: 4 }, alerts: { none: {} }, isDummy: false },
      orderBy: { firstSignalCreatedAt: "asc" },
      take: 100,
    });
  });

  it("rejects a viewer (admin/pipeline only)", async () => {
    const findMany = vi.fn();
    await expect(
      eventResolvers.Query.eventsPendingAlert({}, {}, ctx({ events: { findMany } }, "viewer")),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts a pipeline-role user", async () => {
    const findMany = vi.fn(async () => []);
    await eventResolvers.Query.eventsPendingAlert({}, {}, ctx({ events: { findMany } }, "pipeline"));
    expect(findMany).toHaveBeenCalled();
  });
});

// ─── B. Crisis ───────────────────────────────────────────────────────────────

describe("pendingCrises", () => {
  it("filters enrichmentStatus=PENDING oldest-first and clamps `first` up to 1", async () => {
    const findMany = vi.fn(async () => []);
    await crisisResolvers.Query.pendingCrises({}, { first: 0 }, ctx({ crises: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({
      where: { enrichmentStatus: "PENDING" },
      orderBy: { updatedAt: "asc" },
      take: 1, // clamped up from 0
    });
  });

  it("rejects a viewer (admin/pipeline only)", async () => {
    const findMany = vi.fn();
    await expect(
      crisisResolvers.Query.pendingCrises({}, {}, ctx({ crises: { findMany } }, "viewer")),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts a pipeline-role user", async () => {
    const findMany = vi.fn(async () => []);
    await crisisResolvers.Query.pendingCrises({}, {}, ctx({ crises: { findMany } }, "pipeline"));
    expect(findMany).toHaveBeenCalled();
  });
});

describe("markCrisisEnriched", () => {
  it("sets enrichmentStatus=ENRICHED when the crisis exists", async () => {
    const findUnique = vi.fn(async () => ({ id: "c1" }));
    const update = vi.fn(async () => ({ id: "c1", enrichmentStatus: "ENRICHED" }));
    const context = ctx({ crises: { findUnique, update } });

    await crisisResolvers.Mutation.markCrisisEnriched({}, { id: "c1" }, context);

    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { enrichmentStatus: "ENRICHED" },
    });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const findUnique = vi.fn(async () => null);
    const update = vi.fn();
    await expect(
      crisisResolvers.Mutation.markCrisisEnriched({}, { id: "nope" }, ctx({ crises: { findUnique, update } })),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a viewer (admin/pipeline only)", async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    await expect(
      crisisResolvers.Mutation.markCrisisEnriched({}, { id: "c1" }, ctx({ crises: { findUnique, update } }, "viewer")),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(update).not.toHaveBeenCalled();
  });

  it("accepts a pipeline-role user", async () => {
    const findUnique = vi.fn(async () => ({ id: "c1" }));
    const update = vi.fn(async () => ({ id: "c1", enrichmentStatus: "ENRICHED" }));
    await crisisResolvers.Mutation.markCrisisEnriched(
      {}, { id: "c1" }, ctx({ crises: { findUnique, update } }, "pipeline"),
    );
    expect(update).toHaveBeenCalled();
  });
});

// ─── C. Translation ──────────────────────────────────────────────────────────

describe("pendingTranslations", () => {
  it("lowercases entityType/locale filters and clamps `first`", async () => {
    const findMany = vi.fn(async () => []);
    await translationResolvers.Query.pendingTranslations(
      {}, { first: 700, entityType: "Crisis", locale: "AR" }, ctx({ translationQueue: { findMany } }),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { entityType: "crisis", locale: "ar" },
      orderBy: { enqueuedAt: "asc" },
      take: 500,
    });
  });

  it("normalises a camelCase entityType filter instead of lowercasing it", async () => {
    const findMany = vi.fn(async () => []);
    await translationResolvers.Query.pendingTranslations(
      {}, { entityType: "groundmessage" }, ctx({ translationQueue: { findMany } }),
    );
    expect(findMany.mock.calls[0][0].where).toEqual({ entityType: "groundMessage" });
  });
});

describe("enqueueTranslation", () => {
  it("upserts a queue row for a valid entity/locale (idempotent)", async () => {
    const findUnique = vi.fn(async () => ({ id: "e1" }));
    const upsert = vi.fn(async () => ({ id: "q1" }));
    const context = ctx({ events: { findUnique }, translationQueue: { upsert } });

    await translationResolvers.Mutation.enqueueTranslation(
      {}, { entityType: "event", entityId: "e1", locale: "fr" }, context,
    );

    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      entityType_entityId_locale: { entityType: "event", entityId: "e1", locale: "fr" },
    });
    expect(call.create).toEqual({ entityType: "event", entityId: "e1", locale: "fr" });
    expect(call.update).toEqual({}); // idempotent — keep original enqueuedAt
  });

  it("rejects the canonical 'en' locale", async () => {
    const upsert = vi.fn();
    await expect(
      translationResolvers.Mutation.enqueueTranslation(
        {}, { entityType: "event", entityId: "e1", locale: "en" }, ctx({ translationQueue: { upsert } }),
      ),
    ).rejects.toBeInstanceOf(GraphQLError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("accepts 'en' for a groundMessage (its source is the reporter's language)", async () => {
    const findUnique = vi.fn(async () => ({ id: "m1" }));
    const upsert = vi.fn(async () => ({ id: "q1" }));
    await translationResolvers.Mutation.enqueueTranslation(
      {},
      { entityType: "groundMessage", entityId: "m1", locale: "en" },
      ctx({ groundMessages: { findUnique }, translationQueue: { upsert } }),
    );
    expect(upsert.mock.calls[0][0].create).toEqual({
      entityType: "groundMessage",
      entityId: "m1",
      locale: "en",
    });
  });

  it("rejects an unsupported locale", async () => {
    await expect(
      translationResolvers.Mutation.enqueueTranslation(
        {}, { entityType: "event", entityId: "e1", locale: "zz" }, ctx({ translationQueue: { upsert: vi.fn() } }),
      ),
    ).rejects.toBeInstanceOf(GraphQLError);
  });

  it("rejects an invalid entityType", async () => {
    await expect(
      translationResolvers.Mutation.enqueueTranslation(
        {}, { entityType: "widget", entityId: "e1", locale: "fr" }, ctx({ translationQueue: { upsert: vi.fn() } }),
      ),
    ).rejects.toBeInstanceOf(GraphQLError);
  });
});

describe("markTranslated", () => {
  it("returns true when a queued row is removed", async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const context = ctx({ translationQueue: { deleteMany } });
    const removed = await translationResolvers.Mutation.markTranslated(
      {}, { entityType: "Crisis", entityId: "c1", locale: "FR" }, context,
    );
    expect(removed).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { entityType: "crisis", entityId: "c1", locale: "fr" },
    });
  });

  it("returns false when nothing was queued", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const removed = await translationResolvers.Mutation.markTranslated(
      {}, { entityType: "event", entityId: "x", locale: "ar" }, ctx({ translationQueue: { deleteMany } }),
    );
    expect(removed).toBe(false);
  });
});
