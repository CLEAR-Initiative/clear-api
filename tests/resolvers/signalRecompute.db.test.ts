/**
 * Integration tests (real Postgres) for the signal retraction / recompute
 * contract: updateSignalContent, markSignalsProcessed, pendingSignals,
 * pendingRecomputes, eventMembers, setEventAggregates.
 *
 * The DB-free suites stub Prisma, so they can't prove the `signalEvents`
 * relation filters, the compare-and-set races, or the column defaults. These
 * run them for real.
 *
 * Self-seeding: every row hangs off a fresh data source / event prefixed with
 * a per-run id and is deleted in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GraphQLError } from "graphql";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `sigrecompute-${Date.now()}`;
const SOURCE_NAME = `${RUN}-src`;
let sourceId = "";
let seq = 0;

const baseCtx = {
  prisma,
  user: { id: `${RUN}-admin`, role: "admin" },
  session: null,
  authMethod: "session",
  locale: "en",
} as unknown as Context;

/** A context whose first `signals.updateMany` runs `meanwhile()` first, to
 *  simulate the drain writing between updateSignalContent's read and write. */
function ctxWithRaceBeforeFirstWrite(meanwhile: () => Promise<void>): Context {
  let fired = false;
  const signalsProxy = new Proxy(prisma.signals, {
    get(target, prop, receiver) {
      if (prop === "updateMany") {
        return async (...args: Parameters<typeof prisma.signals.updateMany>) => {
          if (!fired) {
            fired = true;
            await meanwhile();
          }
          return target.updateMany(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const prismaProxy = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "signals") return signalsProxy;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...baseCtx, prisma: prismaProxy } as unknown as Context;
}

// Far in the past so seeded rows sort first in the oldest-first queues and
// stay inside `take` even when the dev DB holds other pending rows.
const ANCIENT = new Date("1990-01-01T00:00:00Z");

async function seedSignal(
  over: Partial<{
    status: "NEW" | "PROCESSED" | "FAILED" | "NEEDS_RECOMPUTE";
    retracted: boolean;
    revision: number;
    contentHash: string | null;
    rawS3Key: string | null;
    publishedAt: Date;
    casualties: number | null;
    title: string;
  }> = {},
) {
  const n = ++seq;
  return prisma.signals.create({
    data: {
      sourceId,
      externalId: `${RUN}-ext-${n}`,
      rawData: {},
      publishedAt: over.publishedAt ?? new Date(ANCIENT.getTime() + n * 1000),
      title: over.title ?? `sig ${n}`,
      status: over.status ?? "NEW",
      retracted: over.retracted ?? false,
      revision: over.revision ?? 0,
      contentHash: over.contentHash === undefined ? "h1" : over.contentHash,
      rawS3Key: over.rawS3Key ?? null,
      casualties: over.casualties ?? null,
    },
  });
}

async function seedEvent() {
  const now = new Date();
  return prisma.events.create({
    data: {
      id: `${RUN}-ev-${++seq}`,
      title: "Flood in Nyala",
      validTo: now,
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      rank: 0.6,
      severity: 3,
      casualties: 10,
    },
  });
}

async function link(signalId: string, eventId: string) {
  await prisma.signalEvents.create({ data: { signalId, eventId, collectedAt: new Date() } });
}

const get = (id: string) => prisma.signals.findUniqueOrThrow({ where: { id } });

function updateInput(sig: { id: string }, over: Record<string, unknown> = {}) {
  return { input: { id: sig.id, contentHash: "h1", rawData: {}, ...over } };
}

const update = (args: ReturnType<typeof updateInput>, ctx: Context = baseCtx) =>
  signalResolvers.Mutation.updateSignalContent({}, args as never, ctx);

const mark = (args: Record<string, unknown>) =>
  signalResolvers.Mutation.markSignalsProcessed({}, args as never, baseCtx);

const pendingNew = async () =>
  (await signalResolvers.Query.pendingSignals({}, { first: 500, source: SOURCE_NAME }, baseCtx)) as { id: string }[];

const pendingRecompute = async () =>
  (await signalResolvers.Query.pendingRecomputes({}, { first: 500 }, baseCtx)) as { id: string }[];

describeIfDb("signal retraction / recompute (real Postgres)", () => {
  beforeAll(async () => {
    const src = await prisma.dataSources.create({
      data: { name: SOURCE_NAME, type: "test" },
    });
    sourceId = src.id;
  });

  afterAll(async () => {
    await prisma.events.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.signals.deleteMany({ where: { sourceId } });
    await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.$disconnect();
  });

  // ─── Column defaults ───────────────────────────────────────────────────────

  it("API-I-01 backfill defaults: a row inserted without the new columns reads retracted=false, revision=0, status NEW", async () => {
    // Case: an IDMC signal like 'idu 1234' written by the old code path
    // (createSignal, never heard of retraction). Raw INSERT names none of the
    // new columns, as a pre-migration writer would.
    const id = `${RUN}-legacy`;
    await prisma.$executeRaw`
      INSERT INTO signals (id, source_id, external_id, raw_data, published_at, collected_at)
      VALUES (${id}, ${sourceId}, ${`${RUN}-legacy-ext`}, '{}'::jsonb, ${ANCIENT}, now())`;
    const row = await get(id);
    expect(row.retracted).toBe(false);
    expect(row.revision).toBe(0);
    expect(row.status).toBe("NEW");
    expect(row.lastRevisedAt).toBeNull();
  });

  // ─── Queues ────────────────────────────────────────────────────────────────

  it("API-I-02 pendingSignals returns only first-grouping candidates (excludes retracted and already-linked)", async () => {
    // Case: three NEW signals from one source.
    //   plain      — new report, never grouped            -> returned
    //   retracted  — IDMC withdrew it before grouping     -> hidden
    //   linked     — drain linked it to 'Flood in Nyala' but crashed before marking it -> hidden
    //                (belongs to the recompute lane, not a second grouping)
    const ev = await seedEvent();
    const plain = await seedSignal();
    const retracted = await seedSignal({ retracted: true });
    const linked = await seedSignal();
    await link(linked.id, ev.id);

    const ids = (await pendingNew()).map((s) => s.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(retracted.id);
    expect(ids).not.toContain(linked.id);
  });

  it("API-I-03 pendingRecomputes returns NEEDS_RECOMPUTE and NEW-but-linked rows (retracted too); skips the rest", async () => {
    // Case: six signals.
    //   needs        NEEDS_RECOMPUTE, linked                -> returned (a revised figure)
    //   needsRetr    NEEDS_RECOMPUTE, retracted, linked     -> returned (removing it IS the work)
    //   newLinked    NEW, linked, retracted                 -> returned (change landed mid-grouping)
    //   newPlain     NEW, unlinked                          -> NOT (first-grouping lane)
    //   processed    PROCESSED, nothing pending             -> NOT
    //   failed       FAILED                                 -> NOT (terminal, known issue #9)
    const ev = await seedEvent();
    const needs = await seedSignal({ status: "NEEDS_RECOMPUTE" });
    const needsRetr = await seedSignal({ status: "NEEDS_RECOMPUTE", retracted: true });
    const newLinked = await seedSignal({ retracted: true });
    const newPlain = await seedSignal();
    const processed = await seedSignal({ status: "PROCESSED" });
    const failed = await seedSignal({ status: "FAILED" });
    for (const s of [needs, needsRetr, newLinked, processed, failed]) await link(s.id, ev.id);

    const ids = (await pendingRecompute()).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([needs.id, needsRetr.id, newLinked.id]));
    for (const s of [newPlain, processed, failed]) expect(ids).not.toContain(s.id);
  });

  it("API-I-04 pendingRecomputes is oldest-first with a stable id tie-break, and `first` bounds it", async () => {
    // Case: three NEEDS_RECOMPUTE rows published 1980-01-01 00:00:01, :02, :02
    // (the last two tie on publishedAt). Asking first=2 must give the two
    // oldest, ties broken by id ascending, so a drain never skips or repeats.
    const base = new Date("1980-01-01T00:00:00Z");
    const a = await seedSignal({ status: "NEEDS_RECOMPUTE", publishedAt: new Date(base.getTime() + 1000) });
    const b = await seedSignal({ status: "NEEDS_RECOMPUTE", publishedAt: new Date(base.getTime() + 2000) });
    const c = await seedSignal({ status: "NEEDS_RECOMPUTE", publishedAt: new Date(base.getTime() + 2000) });
    const tied = [b.id, c.id].sort();

    const got = (await signalResolvers.Query.pendingRecomputes({}, { first: 2 }, baseCtx)) as { id: string }[];
    expect(got.map((s) => s.id).slice(0, 2)).toEqual([a.id, tied[0]]);
    expect(got).toHaveLength(2);
  });

  // ─── updateSignalContent ───────────────────────────────────────────────────

  it("API-I-05 retraction with an UNCHANGED hash is written: PROCESSED+linked -> NEEDS_RECOMPUTE, revision+1, link kept", async () => {
    // Case: IDMC record 'idu 5678' (hash h1) was grouped into 'Flood in
    // Nyala' and marked PROCESSED. IDMC now supersedes it; gx resends the same
    // content hash h1 with retracted=true, keyed by (sourceId, externalId) like
    // gx does (gold never has the cuid).
    const ev = await seedEvent();
    const sig = await seedSignal({ status: "PROCESSED" });
    await link(sig.id, ev.id);

    const res = (await update({
      input: { sourceId, externalId: sig.externalId, contentHash: "h1", retracted: true, rawData: {} },
    } as never)) as { retracted: boolean };

    const row = await get(sig.id);
    expect(res.retracted).toBe(true);
    expect(row.retracted).toBe(true);
    expect(row.status).toBe("NEEDS_RECOMPUTE");
    expect(row.revision).toBe(1);
    expect(row.lastRevisedAt).not.toBeNull();
    expect(await prisma.signalEvents.count({ where: { signalId: sig.id, eventId: ev.id } })).toBe(1);
  });

  it("API-I-06 un-retract works: the flag flips back and the row is queued for recompute again", async () => {
    // Case: 'idu 5678' was retracted (NEEDS_RECOMPUTE), the drain recomputed
    // and marked it PROCESSED; then IDMC reverses itself (the 'reversal'
    // scenario): same hash h1, retracted=false.
    const ev = await seedEvent();
    const sig = await seedSignal({ status: "PROCESSED", retracted: true, revision: 1 });
    await link(sig.id, ev.id);

    await update(updateInput(sig, { retracted: false }));

    const row = await get(sig.id);
    expect(row.retracted).toBe(false);
    expect(row.status).toBe("NEEDS_RECOMPUTE");
    expect(row.revision).toBe(2);
  });

  it("API-I-07 status transitions on a content revision: FAILED stays FAILED, unlinked NEW stays NEW, linked NEW -> NEEDS_RECOMPUTE", async () => {
    // Case: IDMC revises the displacement figure (hash h1 -> h2) on three rows.
    //   failed    FAILED (e.g. unknown_source)       -> FAILED (terminal)
    //   freshNew  NEW, never linked                  -> NEW (first grouping will see the new content)
    //   newLinked NEW, linked by a drain mid-run     -> NEEDS_RECOMPUTE
    const ev = await seedEvent();
    const failed = await seedSignal({ status: "FAILED" });
    const freshNew = await seedSignal();
    const newLinked = await seedSignal();
    await link(newLinked.id, ev.id);

    for (const s of [failed, freshNew, newLinked]) {
      await update(updateInput(s, { contentHash: "h2", title: "revised" }));
    }

    expect((await get(failed.id)).status).toBe("FAILED");
    expect((await get(freshNew.id)).status).toBe("NEW");
    expect((await get(newLinked.id)).status).toBe("NEEDS_RECOMPUTE");
    for (const s of [failed, freshNew, newLinked]) {
      const r = await get(s.id);
      expect(r.revision).toBe(1);
      expect(r.title).toBe("revised");
      expect(r.contentHash).toBe("h2");
    }
  });

  it("API-I-08 revision / lastRevisedAt rules: first hash seed and a rawS3Key-only change are not revisions; a no-op resend writes nothing", async () => {
    // Case A: a legacy gx row has NULL contentHash. First resend seeds h1:
    //         revision +1, but lastRevisedAt stays NULL (no baseline to revise).
    // Case B: same hash, but the blob moved to a new S3 key (IDMC changed the
    //         record's created_at day): key written, revision/status untouched.
    // Case C: exact same payload again: row returned unchanged, no write.
    const ev = await seedEvent();
    const seed = await seedSignal({ contentHash: null, status: "PROCESSED" });
    await link(seed.id, ev.id);
    await update(updateInput(seed, { contentHash: "h1" }));
    const afterSeed = await get(seed.id);
    expect(afterSeed.revision).toBe(1);
    expect(afterSeed.lastRevisedAt).toBeNull();

    const keyed = await seedSignal({ status: "PROCESSED", rawS3Key: "raw/idmc/2026-01-01/1.json" });
    await link(keyed.id, ev.id);
    await update(updateInput(keyed, { rawS3Key: "raw/idmc/2026-01-02/1.json" }));
    const afterKey = await get(keyed.id);
    expect(afterKey.rawS3Key).toBe("raw/idmc/2026-01-02/1.json");
    expect(afterKey.revision).toBe(0);
    expect(afterKey.lastRevisedAt).toBeNull();
    expect(afterKey.status).toBe("PROCESSED");

    const same = await seedSignal({ status: "PROCESSED" });
    const before = await get(same.id);
    await update(updateInput(same));
    const after = await get(same.id);
    expect(after).toEqual(before);
  });

  it("API-I-09 RACE: drain links and marks the row between the update's read and write -> update re-reads and lands on NEEDS_RECOMPUTE", async () => {
    // Case: IDMC revises 'idu 9001' (h1 -> h2). updateSignalContent reads it as
    // NEW and unlinked (would write NEW). Before its write, the drain groups
    // it into 'Flood in Nyala' and marks it PROCESSED with the OLD content.
    // Without the compare-and-set the update would leave PROCESSED/h1-derived
    // totals forever; with it, the write fails, re-reads (PROCESSED, linked)
    // and writes NEEDS_RECOMPUTE.
    const ev = await seedEvent();
    const sig = await seedSignal();
    const ctx = ctxWithRaceBeforeFirstWrite(async () => {
      await link(sig.id, ev.id);
      await prisma.signals.update({ where: { id: sig.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    });

    await update(updateInput(sig, { contentHash: "h2" }), ctx);

    const row = await get(sig.id);
    expect(row.status).toBe("NEEDS_RECOMPUTE");
    expect(row.revision).toBe(1);
    expect(row.contentHash).toBe("h2");
  });

  it("API-I-10 RACE: a concurrent writer changes the row on EVERY attempt -> CONFLICT after 4 tries, nothing written", async () => {
    // Case: pathological churn. Each time updateSignalContent tries to write,
    // someone bumps the revision first. It must give up with CONFLICT rather
    // than loop forever or overwrite.
    const sig = await seedSignal({ status: "PROCESSED" });
    let writes = 0;
    const signalsProxy = new Proxy(prisma.signals, {
      get(target, prop, receiver) {
        if (prop === "updateMany") {
          return async (...args: Parameters<typeof prisma.signals.updateMany>) => {
            writes++;
            await target.update({ where: { id: sig.id }, data: { revision: { increment: 1 } } });
            return target.updateMany(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const prismaProxy = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "signals") return signalsProxy;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    await expect(
      update(updateInput(sig, { contentHash: "h2" }), { ...baseCtx, prisma: prismaProxy } as unknown as Context),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(writes).toBe(4);
    expect((await get(sig.id)).contentHash).toBe("h1");
  });

  it("API-I-11 lookup errors: no key -> BAD_USER_INPUT; lone externalId -> BAD_USER_INPUT; unknown natural key -> NOT_FOUND", async () => {
    // Case: gx sends sourceId+externalId of a row Postgres never had (reset DB)
    // -> NOT_FOUND so the pipeline can fall back to create. A lone externalId
    // (no sourceId) is ambiguous across sources -> rejected.
    await expect(update({ input: { contentHash: "h", rawData: {} } } as never)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(
      update({ input: { externalId: "x", contentHash: "h", rawData: {} } } as never),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      update({ input: { sourceId, externalId: `${RUN}-missing`, contentHash: "h", rawData: {} } } as never),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  // ─── markSignalsProcessed ──────────────────────────────────────────────────

  it("API-I-12 RACE: drain marks with a stale revision after a retraction landed -> no-op, row stays NEEDS_RECOMPUTE", async () => {
    // Case: the drain fetched 'idu 9002' at revision 0 and is recomputing its
    // event. Meanwhile IDMC retracts it (revision 1, NEEDS_RECOMPUTE). The
    // drain then marks items [{id, revision:0}]. The mark must NOT overwrite
    // the pending recompute, or the retraction would be lost.
    const ev = await seedEvent();
    const sig = await seedSignal({ status: "PROCESSED" });
    await link(sig.id, ev.id);
    await update(updateInput(sig, { retracted: true }));

    const n = await mark({ items: [{ id: sig.id, revision: 0 }] });

    expect(n).toBe(0);
    const row = await get(sig.id);
    expect(row.status).toBe("NEEDS_RECOMPUTE");
    expect(row.processedAt).toBeNull();
  });

  it("API-I-13 items batch is per-row: fresh revision is marked, stale one is skipped, in one call", async () => {
    // Case: drain finished two rows. 'fresh' still at revision 0 -> PROCESSED.
    // 'stale' was bumped to revision 3 after the fetch -> untouched.
    const fresh = await seedSignal({ status: "NEEDS_RECOMPUTE", revision: 0 });
    const stale = await seedSignal({ status: "NEEDS_RECOMPUTE", revision: 3 });

    const n = await mark({ items: [{ id: fresh.id, revision: 0 }, { id: stale.id, revision: 2 }] });

    expect(n).toBe(1);
    expect((await get(fresh.id)).status).toBe("PROCESSED");
    expect((await get(stale.id)).status).toBe("NEEDS_RECOMPUTE");
  });

  it("API-I-14 argument validation: ids+items together, neither, and NEW/NEEDS_RECOMPUTE targets are rejected before any write", async () => {
    // Case: a buggy caller sends both lists, or tries to 'mark' a row NEW.
    const sig = await seedSignal({ status: "NEEDS_RECOMPUTE" });
    for (const args of [
      { ids: [sig.id], items: [{ id: sig.id, revision: 0 }] },
      {},
      { ids: [sig.id], status: "NEW" },
      { ids: [sig.id], status: "NEEDS_RECOMPUTE" },
    ]) {
      await expect(mark(args)).rejects.toBeInstanceOf(GraphQLError);
    }
    expect((await get(sig.id)).status).toBe("NEEDS_RECOMPUTE");
  });

  // ─── eventMembers ──────────────────────────────────────────────────────────

  it("API-I-15 eventMembers: live members only, newest first, bounded by `first`, scoped to the event", async () => {
    // Case: 'Flood in Nyala' has 3 members (published Jan 1, 2, 3) plus a
    // retracted 4th (Jan 4), and another event has its own member.
    // Expect Jan 3, Jan 2, Jan 1 — no retracted row, no foreign row; first=2
    // keeps the two newest.
    const ev = await seedEvent();
    const other = await seedEvent();
    const day = (d: number) => new Date(Date.UTC(1985, 0, d));
    const j1 = await seedSignal({ publishedAt: day(1) });
    const j2 = await seedSignal({ publishedAt: day(2) });
    const j3 = await seedSignal({ publishedAt: day(3) });
    const gone = await seedSignal({ publishedAt: day(4), retracted: true });
    const foreign = await seedSignal({ publishedAt: day(5) });
    for (const s of [j1, j2, j3, gone]) await link(s.id, ev.id);
    await link(foreign.id, other.id);

    const all = (await signalResolvers.Query.eventMembers({}, { eventId: ev.id }, baseCtx)) as { id: string }[];
    expect(all.map((s) => s.id)).toEqual([j3.id, j2.id, j1.id]);

    const two = (await signalResolvers.Query.eventMembers({}, { eventId: ev.id, first: 2 }, baseCtx)) as { id: string }[];
    expect(two.map((s) => s.id)).toEqual([j3.id, j2.id]);
  });

  // ─── setEventAggregates ────────────────────────────────────────────────────

  it("API-I-16 setEventAggregates: explicit null clears, absent field is kept, rank is written", async () => {
    // Case: 'Flood in Nyala' had casualties=10, severity=3. Its last
    // casualty-bearing member is retracted: recompute sends casualties=null,
    // severity absent, rank 0. casualties becomes NULL, severity stays 3.
    const ev = await seedEvent();

    await eventResolvers.Mutation.setEventAggregates({}, { id: ev.id, input: { casualties: null, rank: 0 } } as never, baseCtx);

    const row = await prisma.events.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.casualties).toBeNull();
    expect(row.severity).toBe(3);
    expect(row.rank).toBe(0);
    expect(row.title).toBe("Flood in Nyala");
  });

  it("API-I-17 setEventAggregates BigInt round-trip: populationAffected beyond 2^53 survives exactly; negatives and null work", async () => {
    // Case: 9007199254740993 (2^53+1) as a decimal string must come back
    // identical (a JS number would round it to ...992). Then clear it with null.
    const ev = await seedEvent();
    const big = "9007199254740993";

    await eventResolvers.Mutation.setEventAggregates({}, { id: ev.id, input: { populationAffected: big, populationDisplaced: "-5", rank: 0.2 } } as never, baseCtx);
    const row = await prisma.events.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.populationAffected?.toString()).toBe(big);
    expect(row.populationDisplaced?.toString()).toBe("-5");

    await eventResolvers.Mutation.setEventAggregates({}, { id: ev.id, input: { populationAffected: null, rank: 0.2 } } as never, baseCtx);
    const cleared = await prisma.events.findUniqueOrThrow({ where: { id: ev.id } });
    expect(cleared.populationAffected).toBeNull();
    expect(cleared.populationDisplaced?.toString()).toBe("-5");
  });

  it("API-I-18 setEventAggregates rejects non-decimal population strings and writes nothing; unknown event -> NOT_FOUND", async () => {
    // Case: '' would silently become 0 and '0x10' would become 16 with a bare
    // BigInt(); both must be rejected, leaving the stored value untouched.
    const ev = await seedEvent();
    await eventResolvers.Mutation.setEventAggregates({}, { id: ev.id, input: { populationAffected: "42", rank: 0.1 } } as never, baseCtx);

    for (const bad of ["", "0x10", "12.5", "1e3", " 7"]) {
      await expect(
        eventResolvers.Mutation.setEventAggregates({}, { id: ev.id, input: { populationAffected: bad, rank: 0.1 } } as never, baseCtx),
      ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
    expect((await prisma.events.findUniqueOrThrow({ where: { id: ev.id } })).populationAffected?.toString()).toBe("42");

    await expect(
      eventResolvers.Mutation.setEventAggregates({}, { id: `${RUN}-nope`, input: { rank: 0 } } as never, baseCtx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
