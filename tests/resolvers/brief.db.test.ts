/**
 * Integration tests for Briefs against the real, migrated schema.
 *
 * Self-seeding: a two-level location tree, a data source, Events, an Alert
 * and a Signal, all deleted in afterAll, so this runs against an empty
 * scratch database: `bun run test:db tests/resolvers/brief.db.test.ts`.
 */

import { afterAll, beforeAll, expect, it, vi } from "vitest";

const send = vi.fn(async () => true);
const sendBulk = vi.fn(async (messages: unknown[]) => messages.map(() => true));
vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send, sendBulk })),
}));

import { prisma } from "../../src/lib/prisma.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";
import { computeEntityStats } from "../../src/resolvers/pagination.resolver.js";

const { briefResolvers } = await import("../../src/resolvers/brief.resolver.js");
const { Mutation, Query } = briefResolvers;

const RUN = `brief-db-${Date.now()}`;
const COUNTRY = `${RUN}-country`;
const STATE = `${RUN}-state`;
const ADMIN: Context = {
  prisma,
  user: { id: `${RUN}-admin`, role: "admin", email: `${RUN}@example.org` },
  session: null,
  authMethod: "session",
} as unknown as Context;

const NOW = Date.now();
const HOURS = (h: number) => new Date(NOW - h * 3600 * 1000);

let sourceId = "";
let eventId = "";
let alertId = "";
let signalId = "";
const briefIds: string[] = [];
const listIds: string[] = [];

async function insertLocation(id: string, level: number, parentId: string | null, ancestorIds: string[]) {
  await prisma.$executeRaw`
    INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${id}, ${level}, ${parentId}, ${ancestorIds}::text[], ST_GeomFromText('POINT(0 0)', 4326))
  `;
}

async function newBrief(cadence: "daily" | "weekly" | "monthly" = "daily") {
  const b = await Mutation.createBrief(null, { input: { cadence, locationId: COUNTRY } }, ADMIN);
  briefIds.push(b.id);
  return b;
}

describeIfDb("Briefs (db)", () => {
  beforeAll(async () => {
    await insertLocation(COUNTRY, 0, null, []);
    await insertLocation(STATE, 1, COUNTRY, [COUNTRY]);
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-src`, type: "test" } })).id;
    const event = await prisma.events.create({
      data: {
        title: `${RUN} flood`,
        types: ["FL"],
        severity: 4,
        locationId: STATE,
        firstSignalCreatedAt: HOURS(3),
        lastSignalCreatedAt: HOURS(1),
        rank: 0,
      },
    });
    eventId = event.id;
    alertId = (await prisma.alerts.create({ data: { eventId, status: "published" } })).id;
    const signal = await prisma.signals.create({
      data: {
        sourceId,
        externalId: `${RUN}-sig`,
        rawData: {},
        publishedAt: HOURS(2),
        title: `${RUN} report`,
        severity: 3,
        locationId: STATE,
      },
    });
    signalId = signal.id;
    await prisma.signalEvents.create({ data: { signalId, eventId, collectedAt: HOURS(2) } });
  });

  afterAll(async () => {
    await prisma.brief.deleteMany({ where: { id: { in: briefIds } } });
    await prisma.recipientList.deleteMany({ where: { id: { in: listIds } } });
    await prisma.alerts.deleteMany({ where: { eventId } });
    await prisma.signals.deleteMany({ where: { sourceId } });
    await prisma.events.deleteMany({ where: { id: eventId } });
    await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${[STATE, COUNTRY]}::text[])`;
    await prisma.$disconnect();
  });

  it("sets the window from the cadence and freezes the area name", async () => {
    for (const [cadence, days] of [["daily", 1], ["weekly", 7], ["monthly", 30]] as const) {
      const b = await newBrief(cadence);
      expect(b.windowEnd.getTime() - b.windowStart.getTime()).toBe(days * 24 * 3600 * 1000);
      expect(Math.abs(b.windowEnd.getTime() - Date.now())).toBeLessThan(60_000);
      expect(b.locationName).toBe(COUNTRY);
      expect(b.status).toBe("draft");
    }
  });

  it("addBriefItem builds the snapshot from the database and is idempotent", async () => {
    const b = await newBrief();
    const first = await Mutation.addBriefItem(null, { briefId: b.id, kind: "alert", entityId: alertId }, ADMIN);
    const again = await Mutation.addBriefItem(null, { briefId: b.id, kind: "alert", entityId: alertId }, ADMIN);
    expect(again.id).toBe(first.id);
    expect(first.position).toBe(0);
    expect(first.snapshot).toMatchObject({
      title: `${RUN} flood`,
      severity: 4,
      locationName: STATE,
      eventTypes: ["FL"],
      occurredAt: HOURS(3).toISOString(),
    });
    expect((first.snapshot as { url: string }).url).toMatch(new RegExp(`/event/${eventId}$`));

    const sig = await Mutation.addBriefItem(null, { briefId: b.id, kind: "signal", entityId: signalId }, ADMIN);
    expect(sig.position).toBe(0);
    expect(sig.snapshot).toMatchObject({ title: `${RUN} report`, eventTypes: ["FL"] });
    expect((sig.snapshot as { url: string }).url).toMatch(new RegExp(`/signal/${signalId}$`));

    const ev = await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: eventId }, ADMIN);
    const loaded = await Query.brief(null, { id: b.id }, ADMIN);
    const items = await briefResolvers.Brief.items(loaded!, {}, ADMIN);
    expect(items.map((i) => i.id)).toEqual([first.id, ev.id, sig.id]);
    expect(await prisma.briefItem.count({ where: { briefId: b.id } })).toBe(3);
  });

  it("addBriefItem is NOT_FOUND for an unknown entity", async () => {
    const b = await newBrief();
    await expect(
      Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: `${RUN}-missing` }, ADMIN),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("sendBriefTest emails the caller and leaves the Brief a draft", async () => {
    const b = await newBrief();
    await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: eventId }, ADMIN);
    send.mockClear();
    expect(await Mutation.sendBriefTest(null, { id: b.id }, ADMIN)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toBeDefined();
    const after = await prisma.brief.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe("draft");
    expect(after.sentAt).toBeNull();
  });

  it("edits a draft's text and keeps fields that weren't given", async () => {
    const b = await newBrief();
    await Mutation.updateBrief(null, { id: b.id, input: { summary: "**Calm** day" } }, ADMIN);
    const after = await Mutation.updateBrief(null, { id: b.id, input: { closingNotes: "Next: rains" } }, ADMIN);
    expect(after).toMatchObject({ title: b.title, summary: "**Calm** day", closingNotes: "Next: rains" });
  });

  it("refreshBriefWindow moves the window end to now", async () => {
    const b = await newBrief("weekly");
    await prisma.brief.update({
      where: { id: b.id },
      data: { windowStart: HOURS(24 * 9), windowEnd: HOURS(48) },
    });
    const after = await Mutation.refreshBriefWindow(null, { id: b.id }, ADMIN);
    expect(Math.abs(after.windowEnd.getTime() - Date.now())).toBeLessThan(60_000);
    expect(after.windowEnd.getTime() - after.windowStart.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("reorder persists, notes save, and removal unpicks", async () => {
    const b = await newBrief();
    const e = await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: eventId }, ADMIN);
    const a = await Mutation.addBriefItem(null, { briefId: b.id, kind: "alert", entityId: alertId }, ADMIN);
    // A second event for the group: the alert's event and a fresh one.
    const other = await prisma.events.create({
      data: { title: `${RUN} other`, types: ["DR"], firstSignalCreatedAt: HOURS(5), lastSignalCreatedAt: HOURS(5), rank: 0 },
    });
    try {
      const e2 = await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: other.id }, ADMIN);
      expect(e2.position).toBe(1);
      await Mutation.reorderBriefItems(null, { briefId: b.id, kind: "event", itemIds: [e2.id, e.id] }, ADMIN);
      const rows = await prisma.briefItem.findMany({ where: { briefId: b.id, kind: "event" }, orderBy: { position: "asc" } });
      expect(rows.map((r) => r.id)).toEqual([e2.id, e.id]);

      const noted = await Mutation.updateBriefItemNote(null, { itemId: a.id, note: "Watch this" }, ADMIN);
      expect(noted.note).toBe("Watch this");
      expect((await Mutation.updateBriefItemNote(null, { itemId: a.id, note: " " }, ADMIN)).note).toBeNull();

      expect(await Mutation.removeBriefItem(null, { itemId: e2.id }, ADMIN)).toBe(true);
      expect(await prisma.briefItem.count({ where: { briefId: b.id } })).toBe(2);
    } finally {
      await prisma.events.delete({ where: { id: other.id } });
    }
  });

  it("a sent Brief rejects every change", async () => {
    const b = await newBrief();
    const item = await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: eventId }, ADMIN);
    await prisma.brief.update({ where: { id: b.id }, data: { status: "sent", sentAt: new Date() } });
    const attempts = [
      () => Mutation.updateBrief(null, { id: b.id, input: { summary: "late" } }, ADMIN),
      () => Mutation.refreshBriefWindow(null, { id: b.id }, ADMIN),
      () => Mutation.deleteBrief(null, { id: b.id }, ADMIN),
      () => Mutation.addBriefItem(null, { briefId: b.id, kind: "alert", entityId: alertId }, ADMIN),
      () => Mutation.removeBriefItem(null, { itemId: item.id }, ADMIN),
      () => Mutation.updateBriefItemNote(null, { itemId: item.id, note: "late" }, ADMIN),
      () => Mutation.reorderBriefItems(null, { briefId: b.id, kind: "event", itemIds: [item.id] }, ADMIN),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        message: "Brief already sent",
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const after = await prisma.brief.findUniqueOrThrow({ where: { id: b.id }, include: { items: true } });
    expect(after.summary).toBe("");
    expect(after.items).toHaveLength(1);
    expect(after.items[0].note).toBeNull();
  });

  it("deleteBrief removes a draft and its items", async () => {
    const b = await newBrief();
    await Mutation.addBriefItem(null, { briefId: b.id, kind: "event", entityId: eventId }, ADMIN);
    expect(await Mutation.deleteBrief(null, { id: b.id }, ADMIN)).toBe(true);
    expect(await prisma.brief.findUnique({ where: { id: b.id } })).toBeNull();
    expect(await prisma.briefItem.count({ where: { briefId: b.id } })).toBe(0);
  });

  it("Brief.counts equals computeEntityStats for the same area and window", async () => {
    const b = await newBrief();
    const counts = await briefResolvers.Brief.counts(b, {}, ADMIN);
    for (const entity of ["signal", "event", "alert"] as const) {
      const scope = { entity, locationId: COUNTRY, from: b.windowStart, to: b.windowEnd };
      const sev = await computeEntityStats(prisma, { ...scope, groupBy: "severity" });
      const type = await computeEntityStats(prisma, { ...scope, groupBy: "type" });
      expect(counts[entity]).toEqual({ total: sev.total, bySeverity: sev.buckets, byType: type.buckets });
    }
    // The seeded rows sit inside the window, under the country via its state.
    expect(counts.event.total).toBe(1);
    expect(counts.event.byType).toEqual([{ key: "FL", count: 1 }]);
    expect(counts.alert.bySeverity).toEqual([{ key: "4", count: 1 }]);
    expect(counts.signal.byType).toEqual([{ key: `${RUN}-src`, count: 1 }]);
  });

  it("Brief.counts leaves out what falls outside the window", async () => {
    const b = await newBrief();
    const counts = await briefResolvers.Brief.counts(
      { ...b, windowStart: HOURS(100), windowEnd: HOURS(50) },
      {},
      ADMIN,
    );
    expect(counts.event.total).toBe(0);
    expect(counts.signal.total).toBe(0);
    expect(counts.alert.total).toBe(0);
  });

  it("Recipient lists: unique names, lower-cased unique members, count skips unsubscribed", async () => {
    const list = await Mutation.createRecipientList(null, { name: `${RUN} team` }, ADMIN);
    listIds.push(list.id);
    await expect(Mutation.createRecipientList(null, { name: ` ${RUN} team ` }, ADMIN)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });

    const a = await Mutation.addRecipientListMember(null, { listId: list.id, email: "James@Example.org" }, ADMIN);
    const again = await Mutation.addRecipientListMember(null, { listId: list.id, email: "james@example.ORG" }, ADMIN);
    expect(again.id).toBe(a.id);
    expect(a.email).toBe("james@example.org");
    const b = await Mutation.addRecipientListMember(null, { listId: list.id, email: "andi@example.org" }, ADMIN);
    expect(b.unsubscribeToken).not.toBe(a.unsubscribeToken);

    const lists = await Query.recipientLists(null, {}, ADMIN);
    const mine = lists.find((l) => l.id === list.id)!;
    expect((await briefResolvers.RecipientList.members(mine, {}, ADMIN)).map((m) => m.email)).toEqual([
      "andi@example.org",
      "james@example.org",
    ]);
    expect(await briefResolvers.RecipientList.recipientCount(mine, {}, ADMIN)).toBe(2);

    await prisma.recipientListMember.update({ where: { id: b.id }, data: { unsubscribedAt: new Date() } });
    expect(await briefResolvers.RecipientList.recipientCount(mine, {}, ADMIN)).toBe(1);
    // Re-adding keeps the unsubscribe.
    const readded = await Mutation.addRecipientListMember(null, { listId: list.id, email: "ANDI@example.org" }, ADMIN);
    expect(readded.unsubscribedAt).not.toBeNull();

    expect(await Mutation.removeRecipientListMember(null, { memberId: a.id }, ADMIN)).toBe(true);
    expect(await prisma.recipientListMember.count({ where: { listId: list.id } })).toBe(1);
    await expect(Mutation.removeRecipientListMember(null, { memberId: a.id }, ADMIN)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
});
