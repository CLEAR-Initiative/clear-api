/**
 * Tests for the Situation-Analysis tracer slice:
 *   - `bboxToMultipolygonWkt` — pure WKT builder (no DB; always runs).
 *   - `ensureCountryLocation` — idempotent find-or-create of the level-0
 *     Country, polygon (NOT point) geometry, exact-name match, auth.
 *   - `upsertLocationMetadata` — relaxed to accept the `pipeline` role and
 *     supersede the prior current record.
 *
 * The DB-backed tests follow the repo convention (see signal.resolver.test.ts):
 * run against the real database (DATABASE_URL from `.env`), track every created
 * row, and DELETE it in `afterAll`. `location_metadata` rows cascade-delete with
 * their location, so cleaning up the test locations is sufficient. Skipped
 * automatically when DATABASE_URL is absent (e.g. CI without a DB).
 */

import { describe, it, expect, afterAll } from "vitest";
import { GraphQLError } from "graphql";

import { prisma } from "../../src/lib/prisma.js";
import {
  locationResolvers,
  bboxToMultipolygonWkt,
} from "../../src/resolvers/location.resolver.js";
import { locationMetadataResolvers } from "../../src/resolvers/locationMetadata.resolver.js";
import type { Context } from "../../src/context.js";

// Sudan bbox from the PRD / frontend per-country config.
const SUDAN_BBOX = [21.8, 8.5, 38.6, 22.0];

function buildContext(user: { id: string; role: string } | null): Context {
  return {
    prisma,
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  };
}

const PIPELINE = buildContext({ id: "test-pipeline", role: "pipeline" });
const ADMIN = buildContext({ id: "test-admin", role: "admin" });
const VIEWER = buildContext({ id: "test-viewer", role: "viewer" });
const ANON = buildContext(null);

// ── Pure helper — runs with or without a DB ──────────────────────────────────
describe("bboxToMultipolygonWkt", () => {
  it("builds a closed MULTIPOLYGON ring from [minLng, minLat, maxLng, maxLat]", () => {
    expect(bboxToMultipolygonWkt(SUDAN_BBOX)).toBe(
      "MULTIPOLYGON(((21.8 8.5, 38.6 8.5, 38.6 22, 21.8 22, 21.8 8.5)))",
    );
  });

  it("is a polygon, never a point", () => {
    expect(bboxToMultipolygonWkt(SUDAN_BBOX)).toMatch(/^MULTIPOLYGON/);
    expect(bboxToMultipolygonWkt(SUDAN_BBOX)).not.toContain("POINT");
  });

  it("rejects a malformed bbox", () => {
    expect(() => bboxToMultipolygonWkt([1, 2, 3])).toThrow(GraphQLError);
    expect(() => bboxToMultipolygonWkt([1, 2, Number.NaN, 4])).toThrow(GraphQLError);
    // min must be strictly less than max on both axes.
    expect(() => bboxToMultipolygonWkt([38.6, 8.5, 21.8, 22.0])).toThrow(GraphQLError);
    expect(() => bboxToMultipolygonWkt([21.8, 22.0, 38.6, 8.5])).toThrow(GraphQLError);
  });
});

const enabled = !!process.env.DATABASE_URL;
const describeIfDb = enabled ? describe : describe.skip;

describeIfDb("ensureCountryLocation (DB)", () => {
  const createdLocationIds: string[] = [];
  // Unique per run so the create path is genuinely creating, not finding a
  // seed row, and so concurrent runs never collide.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const COUNTRY = `__TEST_COUNTRY_${stamp}`;

  async function geometryTypeOf(id: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<{ geomtype: string | null }[]>`
      SELECT GeometryType("geometry") as geomtype FROM "locations" WHERE "id" = ${id}
    `;
    return rows[0]?.geomtype ?? null;
  }

  afterAll(async () => {
    if (createdLocationIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${createdLocationIds}::text[])`;
    }
    await prisma.$disconnect();
  });

  it("creates the level-0 Country with a polygon (NOT point) geometry", async () => {
    const loc = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: COUNTRY, bbox: SUDAN_BBOX },
      PIPELINE,
    );
    createdLocationIds.push(loc.id);

    expect(loc.name).toBe(COUNTRY);
    expect(loc.level).toBe(0);
    expect(await geometryTypeOf(loc.id)).toBe("MULTIPOLYGON");
  });

  it("is idempotent: same name → same id, no duplicate row", async () => {
    const first = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: COUNTRY, bbox: SUDAN_BBOX },
      PIPELINE,
    );
    const second = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: COUNTRY, bbox: SUDAN_BBOX },
      ADMIN,
    );
    expect(second.id).toBe(first.id);

    const count = await prisma.locations.count({ where: { name: COUNTRY, level: 0 } });
    expect(count).toBe(1);
  });

  it("matches by exact name (a different name creates a distinct Country)", async () => {
    const existing = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: COUNTRY, bbox: SUDAN_BBOX },
      PIPELINE,
    );
    const other = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: `${COUNTRY}_OTHER`, bbox: SUDAN_BBOX },
      PIPELINE,
    );
    createdLocationIds.push(other.id);
    expect(other.id).not.toBe(existing.id);
  });

  it("accepts admin and pipeline; rejects viewer and unauthenticated", async () => {
    // pipeline + admin already exercised above; assert the rejections.
    await expect(
      locationResolvers.Mutation.ensureCountryLocation(
        null,
        { name: `${COUNTRY}_VIEWER`, bbox: SUDAN_BBOX },
        VIEWER,
      ),
    ).rejects.toThrow(/permission/i);

    await expect(
      locationResolvers.Mutation.ensureCountryLocation(
        null,
        { name: `${COUNTRY}_ANON`, bbox: SUDAN_BBOX },
        ANON,
      ),
    ).rejects.toThrow(/logged in/i);
  });
});

describeIfDb("upsertLocationMetadata — pipeline role + supersede (DB)", () => {
  const createdLocationIds: string[] = [];
  const TYPE = "clear_situation_analysis";
  let countryId: string;

  afterAll(async () => {
    if (createdLocationIds.length > 0) {
      // location_metadata rows cascade-delete with the location.
      await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${createdLocationIds}::text[])`;
    }
    await prisma.$disconnect();
  });

  it("the pipeline role can write a clear_situation_analysis record", async () => {
    const country = await locationResolvers.Mutation.ensureCountryLocation(
      null,
      { name: `__TEST_SA_${Date.now()}`, bbox: SUDAN_BBOX },
      PIPELINE,
    );
    countryId = country.id;
    createdLocationIds.push(country.id);

    const rec = await locationMetadataResolvers.Mutation.upsertLocationMetadata(
      null,
      { input: { locationId: countryId, type: TYPE, data: { summary: null, v: 1 } } },
      PIPELINE,
    );
    expect(rec.validTo).toBeNull();
  });

  it("a second upsert supersedes the prior current record", async () => {
    await locationMetadataResolvers.Mutation.upsertLocationMetadata(
      null,
      { input: { locationId: countryId, type: TYPE, data: { summary: null, v: 2 } } },
      PIPELINE,
    );

    // Exactly one current row, and it's v2.
    const current = await locationMetadataResolvers.Query.locationMetadata(
      null,
      { locationId: countryId, type: TYPE, current: true },
      PIPELINE,
    );
    expect(current).toHaveLength(1);
    expect((current[0].data as { v: number }).v).toBe(2);

    // History keeps both; the prior (v1) row now has validTo set.
    const history = await locationMetadataResolvers.Query.locationMetadataHistory(
      null,
      { locationId: countryId, type: TYPE },
      PIPELINE,
    );
    expect(history).toHaveLength(2);
    const closed = history.filter((r) => r.validTo !== null);
    expect(closed).toHaveLength(1);
  });

  it("rejects a viewer", async () => {
    await expect(
      locationMetadataResolvers.Mutation.upsertLocationMetadata(
        null,
        { input: { locationId: countryId, type: TYPE, data: { v: 3 } } },
        VIEWER,
      ),
    ).rejects.toThrow(/permission/i);
  });
});
