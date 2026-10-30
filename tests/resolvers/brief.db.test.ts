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
});
