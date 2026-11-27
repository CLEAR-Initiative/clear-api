/**
 * Other sites of a Signal against the real schema (ADR-0025, Exponential
 * #1690): the pipeline stores the places a Signal's text names besides its
 * primary location, and `Signal.otherSites` reads them back. The primary
 * location, the origin and the destination do not change.
 *
 * Self-seeding: a country, a district, two points and a Signal, all deleted in
 * afterAll, so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/signalSites.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { GraphQLError } from "graphql";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { setSignalOtherSites } = signalResolvers.Mutation;
const { otherSites } = signalResolvers.Signal;

const RUN = `ss-db-${Date.now()}`;
const COUNTRY_ID = `${RUN}-country`;
const DISTRICT_ID = `${RUN}-district`;
const AIRPORT_ID = `${RUN}-airport`;
const CAMP_ID = `${RUN}-camp`;
const MARKET_ID = `${RUN}-market`;

const as = (id: string, role: string, authMethod = "session"): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod, locale: "en", signalScope: { kind: "full" } }) as unknown as Context;
const pipeline = as(`${RUN}-pipeline`, "pipeline", "api-key");
const member = as(`${RUN}-member`, "member");

let sourceId: string | undefined;
let signalSeq = 0;

async function insertLocation(id: string, name: string, level: number, parentId: string | null, wkt: string) {
  const ancestors = parentId
    ? [parentId, ...(await prisma.locations.findUniqueOrThrow({ where: { id: parentId } })).ancestorIds]
    : [];
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

async function signalAt(locationId: string): Promise<string> {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `h${signalSeq}`,
      title: `Airstrikes around the airport and the camp ${signalSeq++}`,
      publishedAt: new Date("2026-11-20T00:00:00.000Z"),
      locationId,
    },
  });
  return signal.id;
}

const set = (signalId: string, sites: Parameters<typeof setSignalOtherSites>[1]["sites"], context = pipeline) =>
  setSignalOtherSites(null, { signalId, sites }, context);

const read = async (signalId: string) =>
  (
    await otherSites(await prisma.signals.findUniqueOrThrow({ where: { id: signalId } }), undefined, pipeline)
  ).map((site) => ({
    locationId: (site.location as { id: string }).id,
    name: site.name,
    kind: site.kind,
  }));

describeIfDb("Other sites of a Signal against the real schema", () => {
  beforeAll(async () => {
    await insertLocation(COUNTRY_ID, "Testland", 0, null, "MULTIPOLYGON(((80 60, 84 60, 84 64, 80 64, 80 60)))");
    await insertLocation(DISTRICT_ID, "Nyala", 2, COUNTRY_ID, "MULTIPOLYGON(((80 60, 82 60, 82 62, 80 62, 80 60)))");
    await insertLocation(AIRPORT_ID, "Nyala Airport", 4, DISTRICT_ID, "POINT(80.5 60.5)");
    await insertLocation(CAMP_ID, "Dumayyah camp", 4, DISTRICT_ID, "POINT(81.5 61.5)");
    await insertLocation(MARKET_ID, "Nyala market", 4, DISTRICT_ID, "POINT(81 61)");
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    for (const level of [4, 2]) {
      await prisma.locations.deleteMany({ where: { level, ancestorIds: { has: COUNTRY_ID } } });
    }
    await prisma.locations.deleteMany({ where: { id: COUNTRY_ID } });
  });

  it("stores the other sites and reads them back on the Signal, without moving it", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    const before = await prisma.signals.findUniqueOrThrow({ where: { id: signalId } });

    const returned = await set(signalId, [{ locationId: CAMP_ID, name: "Dumayyah camp" }]);

    expect(returned.id).toBe(signalId);
    expect(await read(signalId)).toEqual([{ locationId: CAMP_ID, name: "Dumayyah camp", kind: "NAMED_SITE" }]);
    const after = await prisma.signals.findUniqueOrThrow({ where: { id: signalId } });
    expect({ locationId: after.locationId, originId: after.originId, destinationId: after.destinationId }).toEqual({
      locationId: before.locationId,
      originId: before.originId,
      destinationId: before.destinationId,
    });
  });

  it("reads an empty list for a Signal with no other sites", async () => {
    expect(await read(await signalAt(AIRPORT_ID))).toEqual([]);
  });

  it("refuses a caller that is not the pipeline or an admin", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    await expect(set(signalId, [{ locationId: CAMP_ID }], member)).rejects.toBeInstanceOf(GraphQLError);
    expect(await read(signalId)).toEqual([]);
  });

  it("refuses an unknown Signal or an unknown location, and writes nothing", async () => {
    await expect(set(`${RUN}-nope`, [{ locationId: CAMP_ID }])).rejects.toThrow("Signal not found");
    const signalId = await signalAt(AIRPORT_ID);
    await expect(set(signalId, [{ locationId: CAMP_ID }, { locationId: `${RUN}-nowhere` }])).rejects.toThrow(
      "Location not found",
    );
    expect(await read(signalId)).toEqual([]);
  });

  it("replaces the whole set when the sites are set again", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    await set(signalId, [{ locationId: CAMP_ID, name: "Dumayyah camp" }, { locationId: MARKET_ID, name: "Nyala market" }]);
    await set(signalId, [{ locationId: MARKET_ID, name: "the market" }]);
    expect(await read(signalId)).toEqual([{ locationId: MARKET_ID, name: "the market", kind: "NAMED_SITE" }]);
    await set(signalId, []);
    expect(await read(signalId)).toEqual([]);
  });

  it("gives the same set when the same call is replayed", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    const sites = [{ locationId: CAMP_ID, name: "Dumayyah camp" }];
    await set(signalId, sites);
    await set(signalId, sites);
    expect(await read(signalId)).toEqual([{ locationId: CAMP_ID, name: "Dumayyah camp", kind: "NAMED_SITE" }]);
  });

  it("drops a site that is the primary location, and keeps the first name of a repeated location", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    await set(signalId, [
      { locationId: AIRPORT_ID, name: "Nyala Airport" },
      { locationId: CAMP_ID, name: "Dumayyah camp" },
      { locationId: CAMP_ID, name: "Dumayah" },
    ]);
    expect(await read(signalId)).toEqual([{ locationId: CAMP_ID, name: "Dumayyah camp", kind: "NAMED_SITE" }]);
  });

  it("drops a site that is the origin or the destination of a displacement Signal", async () => {
    const signal = await prisma.signals.create({
      data: {
        sourceId: sourceId!, rawData: {}, contentHash: `h${signalSeq++}`, title: "People fled from the camp to the market",
        publishedAt: new Date("2026-11-20T00:00:00.000Z"), originId: CAMP_ID, destinationId: MARKET_ID,
      },
    });
    await set(signal.id, [{ locationId: CAMP_ID }, { locationId: MARKET_ID }, { locationId: AIRPORT_ID, name: "airport" }]);
    expect(await read(signal.id)).toEqual([{ locationId: AIRPORT_ID, name: "airport", kind: "NAMED_SITE" }]);
  });

  it("stops reading a site once the Signal is moved onto it", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    await set(signalId, [{ locationId: CAMP_ID, name: "Dumayyah camp" }]);
    await prisma.signals.update({ where: { id: signalId }, data: { locationId: CAMP_ID } });
    expect(await read(signalId)).toEqual([]);
  });

  it("keeps one caller's set when two calls overlap", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    const a = [{ locationId: CAMP_ID, name: "Dumayyah camp" }];
    const b = [{ locationId: MARKET_ID, name: "Nyala market" }];
    for (let round = 0; round < 5; round++) {
      await Promise.all([set(signalId, a), set(signalId, b)]);
      const ids = (await read(signalId)).map((site) => site.locationId);
      expect([[CAMP_ID], [MARKET_ID]]).toContainEqual(ids);
    }
  });

  it("drops the sites with the Signal", async () => {
    const signalId = await signalAt(AIRPORT_ID);
    await set(signalId, [{ locationId: MARKET_ID, name: "Nyala market" }]);
    await prisma.signals.delete({ where: { id: signalId } });
    expect(await prisma.signalSites.count({ where: { signalId } })).toBe(0);
  });
});
