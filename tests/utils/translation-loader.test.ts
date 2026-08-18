/**
 * Unit tests for `src/utils/translation-loader.ts` — the per-request
 * DataLoader-style batcher that resolves localized entity blobs.
 *
 * DB-free: the only runtime dependency is `prisma.translations.findMany`,
 * which is stubbed with `vi.fn()` per test. The module imports `PrismaClient`
 * and `Locale` as types only, so nothing here touches a real database — these
 * always run, including in CI.
 *
 * The batching is driven by `queueMicrotask`, so `await loader.load(...)`
 * (or `await Promise.all([...])`) is enough to let a batch flush; no fake
 * timers are required.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  createTranslationLoader,
  type TranslationData,
} from "../../src/utils/translation-loader.js";

/**
 * Build a prisma stub whose only delegate is `translations.findMany`. The
 * caller supplies the mock so each test can assert call args / counts.
 */
function buildPrisma(findMany: ReturnType<typeof vi.fn>): PrismaClient {
  return { translations: { findMany } } as unknown as PrismaClient;
}

describe("createTranslationLoader — canonical locale short-circuit", () => {
  it('returns a no-op loader for "en" that never hits the DB', async () => {
    const findMany = vi.fn();
    const loader = createTranslationLoader(buildPrisma(findMany), "en");

    expect(await loader.load("crisis", "c1")).toBeNull();
    expect(await loader.load("event", "e1")).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('never fires the onMissing hook for "en"', async () => {
    const onMissing = vi.fn();
    const loader = createTranslationLoader(buildPrisma(vi.fn()), "en", onMissing);

    await loader.load("crisis", "c1");
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("createTranslationLoader — load + FK column selection", () => {
  it("resolves a found translation's data blob", async () => {
    const data: TranslationData = { title: "الأزمة" };
    const findMany = vi
      .fn()
      .mockResolvedValue([{ crisisId: "c1", eventId: null, locationId: null, data }]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    expect(await loader.load("crisis", "c1")).toBe(data);
  });

  it("queries the crisisId FK column for crisis loads", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    await loader.load("crisis", "c1");
    expect(findMany).toHaveBeenCalledWith({
      where: { crisisId: { in: ["c1"] }, locale: "ar" },
      select: { eventId: true, crisisId: true, locationId: true, situationAnalysisId: true, data: true },
    });
  });

  it("queries the eventId FK column for event loads", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "fr");

    await loader.load("event", "e1");
    expect(findMany).toHaveBeenCalledWith({
      where: { eventId: { in: ["e1"] }, locale: "fr" },
      select: { eventId: true, crisisId: true, locationId: true, situationAnalysisId: true, data: true },
    });
  });

  it("queries the locationId FK column for location loads", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "fr");

    await loader.load("location", "l1");
    expect(findMany).toHaveBeenCalledWith({
      where: { locationId: { in: ["l1"] }, locale: "fr" },
      select: { eventId: true, crisisId: true, locationId: true, situationAnalysisId: true, data: true },
    });
  });

  it("maps each row back to its id via the matching typed FK column", async () => {
    const cData: TranslationData = { title: "C" };
    const findMany = vi.fn().mockResolvedValue([
      { crisisId: "c1", eventId: null, locationId: null, data: cData },
      { crisisId: "c2", eventId: null, locationId: null, data: { title: "C2" } },
    ]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    const [a, b] = await Promise.all([
      loader.load("crisis", "c1"),
      loader.load("crisis", "c2"),
    ]);
    expect(a).toBe(cData);
    expect(b).toEqual({ title: "C2" });
  });

  it("skips rows whose matching FK column is null (no id to key on)", async () => {
    // A crisis batch row that somehow carries no crisisId is unkeyable and is
    // dropped; the requester therefore resolves to null.
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { crisisId: null, eventId: "e1", locationId: null, data: { title: "X" } },
      ]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    expect(await loader.load("crisis", "c1")).toBeNull();
  });
});

describe("createTranslationLoader — batching & dedup", () => {
  it("collapses loads for the same entity_type into one DB call", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    await Promise.all([
      loader.load("crisis", "c1"),
      loader.load("crisis", "c2"),
      loader.load("crisis", "c3"),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where.crisisId.in).toEqual(["c1", "c2", "c3"]);
  });

  it("dedupes repeated ids in the same batch into one queried id", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    // e.g. Crisis.title + Crisis.summary both ask for the same row.
    await Promise.all([
      loader.load("crisis", "c1"),
      loader.load("crisis", "c1"),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where.crisisId.in).toEqual(["c1"]);
  });

  it("resolves every duplicate waiter from a single found row", async () => {
    const data: TranslationData = { title: "shared" };
    const findMany = vi
      .fn()
      .mockResolvedValue([{ crisisId: "c1", eventId: null, locationId: null, data }]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    const [a, b] = await Promise.all([
      loader.load("crisis", "c1"),
      loader.load("crisis", "c1"),
    ]);
    expect(a).toBe(data);
    expect(b).toBe(data);
  });

  it("issues a separate query per entity_type within the same tick", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    await Promise.all([loader.load("crisis", "c1"), loader.load("event", "e1")]);
    expect(findMany).toHaveBeenCalledTimes(2);
    const columns = findMany.mock.calls.map((c) => Object.keys(c[0].where)[0]);
    expect(columns).toEqual(expect.arrayContaining(["crisisId", "eventId"]));
  });

  it("re-flushes an entity_type in a later tick after its first batch drains", async () => {
    // scheduleFlush deletes the queue entry once a batch drains (rather than
    // leaving a truthy-but-empty array behind), so a `load` issued in a later
    // microtask tick starts a fresh batch and settles. Within a single tick all
    // loads still collapse into one query (covered by the batching tests above);
    // this guards the cross-tick path so the loader can't silently leave a
    // promise pending forever.
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    await loader.load("crisis", "c1");
    expect(findMany).toHaveBeenCalledTimes(1);

    // Second load happens in a later tick (the first already awaited) — it must
    // schedule its own flush and resolve, not hang.
    await expect(loader.load("crisis", "c2")).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe("createTranslationLoader — missing-translation handling", () => {
  it("resolves null when no row exists for the entity", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    expect(await loader.load("crisis", "missing")).toBeNull();
  });

  it("fires onMissing once per missing (entityType, entityId)", async () => {
    const onMissing = vi.fn();
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar", onMissing);

    await Promise.all([loader.load("crisis", "c1"), loader.load("event", "e1")]);
    expect(onMissing).toHaveBeenCalledTimes(2);
    expect(onMissing).toHaveBeenCalledWith("crisis", "c1");
    expect(onMissing).toHaveBeenCalledWith("event", "e1");
  });

  it("dedupes onMissing for the same (type, id) within a single batch", async () => {
    // reportedMisses guards against the same (type, id) firing twice even when
    // multiple field resolvers enqueue it in the same tick. (Cross-batch dedup
    // can't be exercised here because the loader doesn't re-flush an
    // entity_type after its first drain — see the batching suite.)
    const onMissing = vi.fn();
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar", onMissing);

    await Promise.all([loader.load("crisis", "c1"), loader.load("crisis", "c1")]);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith("crisis", "c1");
  });

  it("does not fire onMissing for entities that were found", async () => {
    const onMissing = vi.fn();
    const findMany = vi.fn().mockResolvedValue([
      { crisisId: "c1", eventId: null, locationId: null, data: { title: "found" } },
    ]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar", onMissing);

    // c1 is found, c2 is missing → only c2 reports.
    await Promise.all([loader.load("crisis", "c1"), loader.load("crisis", "c2")]);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith("crisis", "c2");
  });

  it("swallows errors thrown by the onMissing hook without rejecting waiters", async () => {
    const onMissing = vi.fn(() => {
      throw new Error("hook blew up");
    });
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar", onMissing);

    // A misbehaving hook must not poison the resolver — load still resolves null.
    await expect(loader.load("crisis", "c1")).resolves.toBeNull();
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("does not require an onMissing hook (optional)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    await expect(loader.load("crisis", "c1")).resolves.toBeNull();
  });
});

describe("createTranslationLoader — DB error propagation", () => {
  it("rejects every waiter in a failed batch with the underlying error", async () => {
    const err = new Error("connection lost");
    const findMany = vi.fn().mockRejectedValue(err);
    const loader = createTranslationLoader(buildPrisma(findMany), "ar");

    const a = loader.load("crisis", "c1");
    const b = loader.load("crisis", "c2");
    await expect(a).rejects.toBe(err);
    await expect(b).rejects.toBe(err);
  });

  it("does not invoke onMissing when the batch query itself fails", async () => {
    const onMissing = vi.fn();
    const findMany = vi.fn().mockRejectedValue(new Error("boom"));
    const loader = createTranslationLoader(buildPrisma(findMany), "ar", onMissing);

    await expect(loader.load("crisis", "c1")).rejects.toThrow("boom");
    expect(onMissing).not.toHaveBeenCalled();
  });
});
