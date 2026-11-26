/**
 * The decisions feed (ADR-0024, #1287) against the real schema: records after
 * a sequence number, in sequence order, for the pipeline and admins only.
 *
 * Self-seeding; runs against an empty scratch database:
 * `bun run test:db tests/resolvers/decisions.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { decisionResolvers } from "../../src/resolvers/decision.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { decisions } = decisionResolvers.Query;

const RUN = `decisions-db-${Date.now()}`;
const PERSON_ID = `${RUN}-person`;

const ctx = (role: string, authMethod = "api-key"): Context =>
  ({ prisma, user: { id: `${RUN}-${role}`, role }, session: null, authMethod, locale: "en" }) as unknown as Context;

const ids: string[] = [];
const eventIds: string[] = [];

/** A record written straight to the table: this suite tests the reader. */
async function record(subjectId: string, decisionType: "SIGNAL_SEVERITY_SET" | "SIGNAL_LOCATION_DECIDED" = "SIGNAL_SEVERITY_SET") {
  const row = await prisma.decisionRecords.create({
    data: {
      decisionType,
      subjectType: "signal",
      subjectId,
      decidedById: PERSON_ID,
      payload: { severity: 4 },
      definitionVersion: "decision-records-v1",
    },
  });
  ids.push(row.id);
  return row;
}

describeIfDb("the decisions feed against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: PERSON_ID, name: PERSON_ID, email: `${PERSON_ID}@example.test` } });
  });

  afterAll(async () => {
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    // Test cleanup only: no application path deletes a record.
    await prisma.decisionRecords.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: PERSON_ID } });
  });

  it("returns the records after a sequence number, in order, with the last sequence", async () => {
    const [a, b, c] = [await record(`${RUN}-a`), await record(`${RUN}-b`), await record(`${RUN}-c`)];
    const page = await decisions(null, { sinceSequence: Number(a.sequence) }, ctx("pipeline"));
    const mine = page.items.filter((r) => ids.includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([b.id, c.id]);
    expect(page.lastSequence).toBe(Number(page.items.at(-1)!.sequence));
    expect(page.lastSequence).toBeGreaterThanOrEqual(Number(c.sequence));
  });

  it("returns an empty page with the same cursor when nothing is newer", async () => {
    const last = await record(`${RUN}-last`);
    const page = await decisions(null, { sinceSequence: Number(last.sequence) }, ctx("admin"));
    expect(page).toEqual({ items: [], lastSequence: Number(last.sequence) });
  });

  it("reads past a gap a rolled-back transaction left", async () => {
    const before = await record(`${RUN}-before-gap`);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.decisionRecords.create({
          data: { decisionType: "SIGNAL_SEVERITY_SET", subjectType: "signal", subjectId: `${RUN}-rolled-back`, payload: {}, definitionVersion: "v" },
        });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const after = await record(`${RUN}-after-gap`);
    expect(Number(after.sequence) - Number(before.sequence)).toBeGreaterThan(1);

    const page = await decisions(null, { sinceSequence: Number(before.sequence) }, ctx("pipeline"));
    expect(page.items.map((r) => r.id)).toContain(after.id);
  });

  it("refuses a caller that is not the pipeline or an admin", async () => {
    for (const role of ["member", "worker", "agent"]) {
      await expect(decisions(null, { sinceSequence: 0 }, ctx(role, "session"))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    }
    await expect(decisions(null, { sinceSequence: -1 }, ctx("admin"))).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("keeps only the asked-for types, and an empty list means all", async () => {
    const start = await record(`${RUN}-types-start`);
    const sev = await record(`${RUN}-types-sev`);
    const loc = await record(`${RUN}-types-loc`, "SIGNAL_LOCATION_DECIDED");
    const since = Number(start.sequence);

    const onlyLoc = await decisions(null, { sinceSequence: since, types: ["SIGNAL_LOCATION_DECIDED"] }, ctx("pipeline"));
    expect(onlyLoc.items.map((r) => r.id)).toEqual([loc.id]);
    // The cursor is the last row returned, so the reader never re-reads one.
    expect(onlyLoc.lastSequence).toBe(Number(loc.sequence));

    const all = await decisions(null, { sinceSequence: since, types: [] }, ctx("pipeline"));
    expect(all.items.map((r) => r.id)).toEqual([sev.id, loc.id]);
  });

  it("pages by first and never returns more than the hard maximum", async () => {
    const start = await record(`${RUN}-page-start`);
    const rows = [await record(`${RUN}-p1`), await record(`${RUN}-p2`), await record(`${RUN}-p3`)];
    const since = Number(start.sequence);

    const one = await decisions(null, { sinceSequence: since, first: 2 }, ctx("pipeline"));
    expect(one.items.map((r) => r.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    const two = await decisions(null, { sinceSequence: one.lastSequence, first: 2 }, ctx("pipeline"));
    expect(two.items.map((r) => r.id)).toEqual([rows[2]!.id]);

    const huge = await decisions(null, { sinceSequence: 0, first: 1_000_000 }, ctx("pipeline"));
    expect(huge.items.length).toBeLessThanOrEqual(1000);
    await expect(decisions(null, { sinceSequence: 0, first: 0 }, ctx("pipeline"))).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("pages events(lastSignalSince) by id with first and after", async () => {
    const recent = new Date(Date.now() + 365 * 24 * 3600_000); // later than any other row
    for (let n = 0; n < 3; n++) {
      const row = await prisma.events.create({
        data: { types: [], validTo: recent, firstSignalCreatedAt: recent, lastSignalCreatedAt: recent, rank: 0 },
      });
      eventIds.push(row.id);
    }
    const sorted = [...eventIds].sort();
    const since = recent.toISOString();
    // The pipeline reads events with its admin key until #430 lets the pipeline role read content.
    const reader = ctx("admin");

    const one = await eventResolvers.Query.events(null, { lastSignalSince: since, first: 2 }, reader);
    expect(one.map((e: { id: string }) => e.id)).toEqual(sorted.slice(0, 2));
    const two = await eventResolvers.Query.events(null, { lastSignalSince: since, first: 2, after: one.at(-1)!.id }, reader);
    expect(two.map((e: { id: string }) => e.id)).toEqual(sorted.slice(2));

    // limit is ignored in paged mode.
    const withLimit = await eventResolvers.Query.events(null, { lastSignalSince: since, first: 2, limit: 1 }, reader);
    expect(withLimit).toHaveLength(2);
    await expect(eventResolvers.Query.events(null, { first: 0 }, reader)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("never passes a record whose transaction is still open: records commit in sequence order", async () => {
    const start = await record(`${RUN}-order-start`);
    const since = Number(start.sequence);
    const data = (subjectId: string) => ({
      decisionType: "SIGNAL_SEVERITY_SET" as const,
      subjectType: "signal",
      subjectId,
      decidedById: PERSON_ID,
      payload: {},
      definitionVersion: "decision-records-v1",
    });

    // Transaction A inserts and stays open until released.
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));
    let aInserted!: () => void;
    const aHasInserted = new Promise<void>((r) => (aInserted = r));
    const a = prisma.$transaction(async (tx) => {
      const row = await tx.decisionRecords.create({ data: data(`${RUN}-order-a`) });
      aInserted();
      await holdA;
      return row;
    }, { timeout: 20_000 });
    await aHasInserted;

    // Transaction B starts after A has its row, and must wait for A.
    let bDone = false;
    const b = prisma.$transaction((tx) => tx.decisionRecords.create({ data: data(`${RUN}-order-b`) }), { timeout: 20_000 })
      .then((row) => { bDone = true; return row; });
    await new Promise((r) => setTimeout(r, 500));
    expect(bDone).toBe(false);
    // While A is open, the feed shows neither.
    const during = await decisions(null, { sinceSequence: since }, ctx("pipeline"));
    expect(during.items.filter((r) => r.subjectId.startsWith(`${RUN}-order-`))).toEqual([]);

    releaseA();
    const [rowA, rowB] = await Promise.all([a, b]);
    ids.push(rowA.id, rowB.id);
    expect(rowB.sequence > rowA.sequence).toBe(true);
    const after = await decisions(null, { sinceSequence: since }, ctx("pipeline"));
    expect(after.items.filter((r) => r.subjectId.startsWith(`${RUN}-order-`)).map((r) => r.id)).toEqual([rowA.id, rowB.id]);
  });
});
