/**
 * Integration tests for `Query.entityStats` (pagination.resolver.ts) against
 * the real, migrated schema.
 *
 * The grouped paths (groupBy != none) hand-write raw SQL in `statsScope()`,
 * so column/table names are never checked by Prisma's type system. A unit
 * test with a stubbed `$queryRaw` can't catch a wrong column — which is how
 * `is_dummy` (the real column is `"isDummy"`, no @map) shipped and broke
 * every clear_count call. These tests execute the SQL for real.
 *
 * Fixtures hang off a fresh parent + child location, and every query passes
 * `locationId: parent`, so counts are exact regardless of other rows in the DB.
 * Each grouped total is also cross-checked against the Prisma-backed
 * groupBy=none path, which is the reference implementation of the filter.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { paginationResolvers } from "../../src/resolvers/pagination.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { entityStats } = paginationResolvers.Query;

const ctx = {
  prisma,
  user: { id: "entity-stats-test", role: "viewer" },
  session: null,
  authMethod: "session",
} as unknown as Context;

type Entity = "signal" | "event" | "alert";
type GroupBy = "none" | "type" | "severity" | "day" | "week" | "month";

const RUN = `entity-stats-${Date.now()}`;
const SOURCE_NAME = `${RUN}-source`;

describeIfDb("Query.entityStats — raw SQL against the real schema", () => {
  let parentId: string;
  let childId: string;
  let sourceId: string;
  const eventIds: string[] = [];
  const signalIds: string[] = [];
  const alertIds: string[] = [];

  async function stats(entity: Entity, groupBy: GroupBy, extra: Record<string, unknown> = {}) {
    const res = await entityStats(
      null,
      { input: { entity, groupBy, locationId: parentId, ...extra } as never },
      ctx,
    );
    return {
      total: res.total,
      buckets: Object.fromEntries(res.buckets.map((b) => [b.key, b.count])),
    };
  }

  beforeAll(async () => {
    const [parent] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "locations" (id, name, level, ancestor_ids, geometry)
      VALUES (${`${RUN}-parent`}, ${`${RUN} parent`}, 0, '{}',
              ST_SetSRID(ST_MakePoint(0, 0), 4326))
      RETURNING id`;
    parentId = parent!.id;
    const [child] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "locations" (id, name, level, parent_id, ancestor_ids, geometry)
      VALUES (${`${RUN}-child`}, ${`${RUN} child`}, 1, ${parentId}, ${[parentId]}::text[],
              ST_SetSRID(ST_MakePoint(0, 0), 4326))
      RETURNING id`;
    childId = child!.id;

    sourceId = (await prisma.dataSources.create({ data: { name: SOURCE_NAME, type: "test" } })).id;

    // Events — 3 real (two in parent, one in child) + 1 dummy.
    const ev = async (
      d: { types: string[]; severity: number; at: string; isDummy?: boolean },
      loc: "origin" | "general",
      locId: string,
    ) => {
      const at = new Date(d.at);
      const row = await prisma.events.create({
        data: {
          types: d.types,
          severity: d.severity,
          isDummy: d.isDummy ?? false,
          validTo: at,
          firstSignalCreatedAt: at,
          lastSignalCreatedAt: at,
          rank: 0,
          ...(loc === "origin" ? { originId: locId } : { locationId: locId }),
        },
      });
      eventIds.push(row.id);
      return row;
    };
    const e1 = await ev(
      { types: ["FL"], severity: 3, at: "2020-01-06T12:00:00Z" },
      "origin",
      parentId,
    );
    await ev({ types: ["FL", "DR"], severity: 4, at: "2020-01-07T12:00:00Z" }, "general", parentId);
    await ev({ types: ["DR"], severity: 2, at: "2020-01-15T12:00:00Z" }, "general", childId);
    const eDummy = await ev(
      { types: ["FL"], severity: 5, at: "2020-01-08T12:00:00Z", isDummy: true },
      "general",
      childId,
    );

    // Signals — 2 real + 1 dummy.
    const sig = async (d: { severity: number; at: string; isDummy?: boolean }, locId: string) => {
      const row = await prisma.signals.create({
        data: {
          sourceId,
          rawData: {},
          publishedAt: new Date(d.at),
          severity: d.severity,
          isDummy: d.isDummy ?? false,
          originId: locId,
        },
      });
      signalIds.push(row.id);
    };
    await sig({ severity: 3, at: "2020-01-06T12:00:00Z" }, parentId);
    await sig({ severity: 1, at: "2020-01-20T12:00:00Z" }, childId);
    await sig({ severity: 5, at: "2020-01-06T12:00:00Z", isDummy: true }, childId);

    // Alerts — one on a real event, one on the dummy event.
    for (const eventId of [e1.id, eDummy.id]) {
      alertIds.push((await prisma.alerts.create({ data: { eventId, status: "published" } })).id);
    }
  });

  afterAll(async () => {
    await prisma.alerts.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.signals.deleteMany({ where: { id: { in: signalIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    if (sourceId) await prisma.dataSources.delete({ where: { id: sourceId } });
    await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${[childId, parentId].filter(Boolean)}::text[])`;
    await prisma.$disconnect();
  });

  describe("event", () => {
    it("groups by type (unnested), excluding dummies", async () => {
      expect(await stats("event", "type")).toEqual({ total: 3, buckets: { FL: 2, DR: 2 } });
    });

    it("groups by severity", async () => {
      expect(await stats("event", "severity")).toEqual({
        total: 3,
        buckets: { "2": 1, "3": 1, "4": 1 },
      });
    });

    it("groups by ISO week", async () => {
      expect(await stats("event", "week")).toEqual({
        total: 3,
        buckets: { "2020-W02": 2, "2020-W03": 1 },
      });
    });

    it("includes dummies when includeDummy is set", async () => {
      const res = await stats("event", "severity", { includeDummy: true });
      expect(res.total).toBe(4);
      expect(res.buckets["5"]).toBe(1);
    });

    it("applies bound filter values (severity, date range, eventTypes)", async () => {
      expect((await stats("event", "type", { severityMin: 3 })).total).toBe(2);
      expect((await stats("event", "type", { severityMax: 2 })).total).toBe(1);
      expect((await stats("event", "week", { from: "2020-01-10T00:00:00Z" })).total).toBe(1);
      expect((await stats("event", "week", { to: "2020-01-10T00:00:00Z" })).total).toBe(2);
      expect(await stats("event", "type", { eventTypes: ["DR"] })).toEqual({
        total: 2,
        buckets: { FL: 1, DR: 2 },
      });
    });
  });

  describe("signal", () => {
    it("groups by data source name, excluding dummies", async () => {
      expect(await stats("signal", "type")).toEqual({ total: 2, buckets: { [SOURCE_NAME]: 2 } });
    });

    it("groups by severity and week", async () => {
      expect(await stats("signal", "severity")).toEqual({ total: 2, buckets: { "1": 1, "3": 1 } });
      expect(await stats("signal", "week")).toEqual({
        total: 2,
        buckets: { "2020-W02": 1, "2020-W04": 1 },
      });
    });

    it("applies bound filter values", async () => {
      expect((await stats("signal", "severity", { severityMin: 2 })).total).toBe(1);
      expect((await stats("signal", "day", { from: "2020-01-10T00:00:00Z" })).total).toBe(1);
      expect((await stats("signal", "month", { includeDummy: true })).buckets).toEqual({
        "2020-01": 3,
      });
    });
  });

  describe("alert", () => {
    it("groups via the joined event, excluding dummy events", async () => {
      expect(await stats("alert", "type")).toEqual({ total: 1, buckets: { FL: 1 } });
      expect(await stats("alert", "severity", { includeDummy: true })).toEqual({
        total: 2,
        buckets: { "3": 1, "5": 1 },
      });
      expect((await stats("alert", "week", { severityMin: 4 })).total).toBe(0);
    });
  });

  it.each<[Entity, GroupBy, Record<string, unknown>]>([
    ["event", "type", {}],
    ["event", "week", { severityMin: 3, from: "2020-01-01T00:00:00Z" }],
    ["event", "severity", { includeDummy: true, eventTypes: ["FL"] }],
    ["signal", "type", {}],
    ["signal", "day", { severityMax: 3 }],
    ["alert", "month", { includeDummy: true }],
  ])("%s grouped by %s totals match the groupBy=none path (%o)", async (entity, groupBy, extra) => {
    const grouped = await stats(entity, groupBy, extra);
    const none = await stats(entity, "none", extra);
    expect(grouped.total).toBe(none.total);
  });
});
