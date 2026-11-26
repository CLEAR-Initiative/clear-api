/**
 * The pipeline's own identity (#430) against the real schema: a key of the
 * `pipeline` service user runs an ingest end to end, its writes are the
 * pipeline's (no DecisionRecord, ADR-0024), and it cannot make a person's
 * decision.
 *
 * Self-seeding; runs against an empty scratch database:
 * `bun run test:db tests/resolvers/pipelineIdentity.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import { alertResolvers } from "../../src/resolvers/alert.resolver.js";
import { locationResolvers } from "../../src/resolvers/location.resolver.js";
import { nominatimCacheResolvers } from "../../src/resolvers/nominatimCache.resolver.js";
import { dataSourceResolvers } from "../../src/resolvers/dataSource.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `pipeline-id-${Date.now()}`;
const PIPELINE_ID = `${RUN}-pipeline`;
const COUNTRY_ID = `${RUN}-country`;
const DISTRICT_ID = `${RUN}-district`;

/** The pipeline's key: the `pipeline` service user over an API key. */
const pipeline = {
  prisma,
  user: { id: PIPELINE_ID, role: "pipeline" },
  session: null,
  authMethod: "api-key",
  viaAgent: false,
  locale: "en",
  signalScope: { kind: "full" },
} as unknown as Context;

let sourceId: string | undefined;
const signalIds: string[] = [];
const eventIds: string[] = [];

describeIfDb("the pipeline service user against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: PIPELINE_ID, name: "CLEAR Pipeline", email: `${PIPELINE_ID}@example.test`, role: "pipeline" } });
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY_ID}, 'Pipeland', 0, ARRAY[]::text[],
              ST_GeomFromText('MULTIPOLYGON(((60 60, 64 60, 64 64, 60 64, 60 60)))', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT_ID}, 'Pipeville', 2, ${COUNTRY_ID}, ARRAY[${COUNTRY_ID}]::text[],
              ST_GeomFromText('MULTIPOLYGON(((61 61, 63 61, 63 63, 61 63, 61 61)))', 4326))`;
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.alerts.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.eventEscaladedByUsers.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.nominatim_cache.deleteMany({ where: { queryHash: { startsWith: RUN } } });
    await prisma.locations.deleteMany({ where: { ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { id: COUNTRY_ID } });
    await prisma.user.deleteMany({ where: { id: PIPELINE_ID } });
  });

  it("runs an ingest: reads sources, uses the geocoder cache, creates a landmark and a signal", async () => {
    const sources = await dataSourceResolvers.Query.dataSources(null, {}, pipeline);
    expect(sources.map((s: { id: string }) => s.id)).toContain(sourceId);

    await nominatimCacheResolvers.Mutation.upsertNominatimCache(
      null,
      {
        input: {
          queryHash: `${RUN}-q1`,
          query: "Pipeville market",
          endpoint: "search",
          responseJson: [],
          status: "ok",
          ttlSeconds: 3600,
        },
      },
      pipeline,
    );
    const cached = await nominatimCacheResolvers.Query.nominatimCacheEntry(null, { queryHash: `${RUN}-q1` }, pipeline);
    expect(cached).toMatchObject({ queryHash: `${RUN}-q1` });

    const landmark = await locationResolvers.Mutation.findOrCreateLandmarkL4(
      null,
      { input: { name: "Pipeville market", lat: 62, lng: 62, kind: "landmark" } },
      pipeline,
    );
    expect(landmark.locationId).toBeTruthy();

    const signal = await signalResolvers.Mutation.createSignal(
      null,
      {
        input: {
          sourceId: sourceId!,
          externalId: `test:${RUN}-1`,
          rawData: {},
          publishedAt: new Date().toISOString(),
          title: "Shelling near the market",
          locationId: landmark.locationId!,
        },
      },
      pipeline,
    );
    signalIds.push(signal.id);
    expect(signal.locationId).toBe(landmark.locationId);
  });

  it("groups, scores and alerts as the pipeline, and records no decision", async () => {
    const now = new Date().toISOString();
    const event = await eventResolvers.Mutation.createEvent(
      null,
      { input: { signalIds, validFrom: now, firstSignalCreatedAt: now, lastSignalCreatedAt: now, types: [], rank: 0, title: "Shelling" } },
      pipeline,
    );
    eventIds.push(event.id);
    await eventResolvers.Mutation.updateEvent(null, { id: event.id, input: { severity: 4 } }, pipeline);
    await signalResolvers.Mutation.updateSignalSeverity(null, { id: signalIds[0]!, severity: 4 }, pipeline);
    const alert = await alertResolvers.Mutation.createAlert(null, { input: { eventId: event.id, status: "draft" } }, pipeline);
    expect(alert).toBeTruthy();

    // The pipeline's writes are reproducible, so none is a person's decision.
    expect(await prisma.decisionRecords.count({ where: { subjectId: { in: [event.id, alert!.id, ...signalIds] } } })).toBe(0);
    // A severity the pipeline set is not a decided one.
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalIds[0]! } })).severityCorrectedAt).toBeNull();
  });

  it("cannot make a person's decision", async () => {
    await expect(
      signalResolvers.Mutation.createManualSignal(
        null,
        { input: { sourceId: sourceId!, title: "Filed by a person" } },
        pipeline,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});
