/**
 * Integration tests for `updateEvent`'s signal-time bounds against the real
 * schema.
 *
 * The DB-free suite only sees the conditional `updateMany` calls; this checks
 * what they do to a row: `lastSignalCreatedAt` only moves later and
 * `firstSignalCreatedAt` only moves earlier, so an out-of-order Signal joining
 * an Event can't drag it out of grouping's active window or the alert window.
 *
 * Self-seeding: each test makes its own Event, deleted in afterAll, so this
 * runs against an empty scratch database:
 * `bun run test:db tests/resolvers/event.db.test.ts`.
 */

import { it, expect, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { updateEvent } = eventResolvers.Mutation;

const analyst = {
  prisma,
  user: { id: `event-db-${Date.now()}-analyst`, role: "analyst" },
  session: null,
  authMethod: "session",
} as unknown as Context;

const FIRST = new Date("2026-05-01T00:00:00.000Z");
const LAST = new Date("2026-05-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const eventIds: string[] = [];

async function makeEvent(): Promise<string> {
  const row = await prisma.events.create({
    data: {
      types: ["FL"],
      validTo: LAST,
      firstSignalCreatedAt: FIRST,
      lastSignalCreatedAt: LAST,
      rank: 0,
    },
  });
  eventIds.push(row.id);
  return row.id;
}

describeIfDb("updateEvent signal-time bounds against the real schema", () => {
  afterAll(async () => {
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
  });

  it("leaves lastSignalCreatedAt alone when an older Signal joins", async () => {
    const id = await makeEvent();
    const older = new Date(LAST.getTime() - 5 * DAY);
    const row = await updateEvent(
      null,
      { id, input: { lastSignalCreatedAt: older.toISOString() } },
      analyst,
    );
    expect(row.lastSignalCreatedAt).toEqual(LAST);
    expect((await prisma.events.findUniqueOrThrow({ where: { id } })).lastSignalCreatedAt).toEqual(LAST);
  });

  it("advances lastSignalCreatedAt when a newer Signal joins", async () => {
    const id = await makeEvent();
    const newer = new Date(LAST.getTime() + DAY);
    const row = await updateEvent(
      null,
      { id, input: { lastSignalCreatedAt: newer.toISOString() } },
      analyst,
    );
    expect(row.lastSignalCreatedAt).toEqual(newer);
  });

  it("only moves firstSignalCreatedAt earlier", async () => {
    const id = await makeEvent();
    const later = new Date(FIRST.getTime() + DAY);
    const earlier = new Date(FIRST.getTime() - DAY);

    const unchanged = await updateEvent(null, { id, input: { firstSignalCreatedAt: later.toISOString() } }, analyst);
    expect(unchanged.firstSignalCreatedAt).toEqual(FIRST);

    const moved = await updateEvent(null, { id, input: { firstSignalCreatedAt: earlier.toISOString() } }, analyst);
    expect(moved.firstSignalCreatedAt).toEqual(earlier);
  });

  it("keeps the newest lastSignalCreatedAt under concurrent out-of-order writes", async () => {
    const id = await makeEvent();
    const stamps = [3, 1, 4, 2].map((d) => new Date(LAST.getTime() + d * DAY));
    await Promise.all(
      stamps.map((t) => updateEvent(null, { id, input: { lastSignalCreatedAt: t.toISOString() } }, analyst)),
    );
    const row = await prisma.events.findUniqueOrThrow({ where: { id } });
    expect(row.lastSignalCreatedAt).toEqual(new Date(LAST.getTime() + 4 * DAY));
  });
});
