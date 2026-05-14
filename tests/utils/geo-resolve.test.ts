/**
 * Integration tests for L4 (point) location parent + ancestor resolution.
 *
 * Locks in the fix from the L4-cascade bug:
 *   - `resolveLatLngToLocation` must pick the most granular admin polygon
 *     (A2 > A1 > A0) and NEVER return a level-4 sibling — even when an L4
 *     row exists at the exact same coordinates.
 *   - `createPointLocation` must store an `ancestor_ids` array walking the
 *     full parent chain from the direct A2 parent up to the country (A0).
 *
 * Runs against the real database (uses DATABASE_URL from .env). All
 * fixture rows are tracked and DELETEd in afterAll so the suite is
 * idempotent. Skipped automatically when DATABASE_URL is missing.
 */

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  resolveLatLngToLocation,
  createPointLocation,
  resolvePointsToCommonAncestor,
} from "../../src/utils/geo-resolve.js";

// Inside Al Kurmuk district (Blue Nile state, Sudan). Same coordinates we
// debugged when the L4-cascade bug surfaced. Picked because it sits well
// inside an A2 polygon (not on a boundary) so the test asserts *content*
// behaviour, not boundary edge cases.
const AL_KURMUK_LAT = 10.5197145;
const AL_KURMUK_LNG = 33.9750018;
const AL_KURMUK_NAME = "Al Kurmuk";
const BLUE_NILE_NAME = "Blue Nile";
const SUDAN_NAME = "Sudan";

const enabled = !!process.env.DATABASE_URL;
const describeIfDb = enabled ? describe : describe.skip;

describeIfDb("geo-resolve — L4 parent + ancestor resolution", () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ANY(${createdIds}::text[])`;
    }
    await prisma.$disconnect();
  });

  describe("resolveLatLngToLocation", () => {
    it("returns the containing A2 polygon for an in-district point", async () => {
      const result = await resolveLatLngToLocation(
        prisma,
        AL_KURMUK_LAT,
        AL_KURMUK_LNG,
      );

      expect(result).not.toBeNull();
      expect(result?.level).toBe(2);
      expect(result?.name).toBe(AL_KURMUK_NAME);
    });

    it("ignores level-4 siblings even when an L4 row exists at the same coords", async () => {
      // Plant a poison L4 row at the exact target coordinates. Before the
      // `level < 4` filter this would have won the ranking over the A2
      // (ORDER BY level DESC), reproducing the cascade bug.
      const poisonId = `test-l4-poison-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdIds.push(poisonId);
      await prisma.$executeRaw`
        INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (
          ${poisonId},
          'TEST POISON L4',
          4,
          NULL,
          ARRAY[]::text[],
          ST_SetSRID(ST_MakePoint(${AL_KURMUK_LNG}, ${AL_KURMUK_LAT}), 4326)
        )
      `;

      const result = await resolveLatLngToLocation(
        prisma,
        AL_KURMUK_LAT,
        AL_KURMUK_LNG,
      );

      // Must NOT pick the poison row, must still pick Al Kurmuk (A2).
      expect(result?.level).toBe(2);
      expect(result?.id).not.toBe(poisonId);
      expect(result?.name).toBe(AL_KURMUK_NAME);
    });
  });

  describe("createPointLocation", () => {
    it("stores parent_id = direct A2 + ancestor_ids walking up to A0", async () => {
      const created = await createPointLocation(
        prisma,
        AL_KURMUK_LAT,
        AL_KURMUK_LNG,
        "TEST PT — parent chain",
      );
      createdIds.push(created.id);

      const row = await prisma.locations.findUnique({
        where: { id: created.id },
        select: {
          parentId: true,
          ancestorIds: true,
          parent: { select: { id: true, name: true, level: true } },
        },
      });

      expect(row).not.toBeNull();
      expect(row?.parent?.level).toBe(2);
      expect(row?.parent?.name).toBe(AL_KURMUK_NAME);

      // The ancestor array must lead with the direct parent and reach the
      // country level. Sudan's hierarchy is A2 → A1 → A0 (3 entries).
      expect(row?.ancestorIds.length).toBeGreaterThanOrEqual(3);
      expect(row?.ancestorIds[0]).toBe(row?.parent?.id);

      const ancestors = await prisma.locations.findMany({
        where: { id: { in: row!.ancestorIds } },
        select: { id: true, name: true, level: true },
      });
      const byId = new Map(ancestors.map((a) => [a.id, a]));
      const levels = row!.ancestorIds.map((id) => byId.get(id)?.level);
      const names = row!.ancestorIds.map((id) => byId.get(id)?.name);

      // Direct parent (depth 0) → A2; chain must contain both A1 and A0.
      expect(levels[0]).toBe(2);
      expect(levels).toContain(1);
      expect(levels).toContain(0);
      expect(names).toContain(BLUE_NILE_NAME);
      expect(names).toContain(SUDAN_NAME);
    });

    it("picks the A2 (not an L4 sibling) when other L4 rows share the coords", async () => {
      // Pre-seed a sibling L4 at the same point — guards against any future
      // regression that reintroduces L4 rows into parent candidates.
      const siblingId = `test-l4-sibling-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdIds.push(siblingId);
      await prisma.$executeRaw`
        INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (
          ${siblingId},
          'TEST SIBLING L4',
          4,
          NULL,
          ARRAY[]::text[],
          ST_SetSRID(ST_MakePoint(${AL_KURMUK_LNG}, ${AL_KURMUK_LAT}), 4326)
        )
      `;

      const created = await createPointLocation(
        prisma,
        AL_KURMUK_LAT,
        AL_KURMUK_LNG,
        "TEST PT — with sibling",
      );
      createdIds.push(created.id);

      const row = await prisma.locations.findUnique({
        where: { id: created.id },
        select: {
          parentId: true,
          ancestorIds: true,
          parent: { select: { level: true, name: true } },
        },
      });

      expect(row?.parent?.level).toBe(2);
      expect(row?.parent?.name).toBe(AL_KURMUK_NAME);
      // The sibling L4 must NOT appear anywhere in the ancestor chain.
      expect(row?.ancestorIds).not.toContain(siblingId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // resolvePointsToCommonAncestor — used by the multi-signal createEvent
  // path. Returns the deepest admin polygon containing every input point,
  // so events with signals scattered across an A2 attach to that A2; events
  // spanning two A2s attach to their shared A1; cross-state events fall back
  // to A0. Replaces the older convex-hull region approach which polluted
  // the `locations` table with non-administrative L4 rows per event.
  // ──────────────────────────────────────────────────────────────────────

  // Two more known points used for the multi-A2 / multi-A1 cases:
  //   Baw (A2, in Blue Nile state — same A1 as Al Kurmuk)
  const BAW_LAT = 11.133073;
  const BAW_LNG = 33.800953;
  //   Khartoum (A2, in Khartoum state — different A1 entirely)
  const KHARTOUM_LAT = 15.552506;
  const KHARTOUM_LNG = 32.561114;

  describe("resolvePointsToCommonAncestor", () => {
    it("returns null for an empty point set", async () => {
      const result = await resolvePointsToCommonAncestor(prisma, []);
      expect(result).toBeNull();
    });

    it("delegates to the single-point resolver for one point", async () => {
      const result = await resolvePointsToCommonAncestor(prisma, [
        { lat: AL_KURMUK_LAT, lng: AL_KURMUK_LNG },
      ]);
      expect(result?.level).toBe(2);
      expect(result?.name).toBe(AL_KURMUK_NAME);
    });

    it("returns the shared A2 when all points sit in the same district", async () => {
      // Two distinct points both inside Al Kurmuk's polygon (one user-provided
      // sample, one taken from the polygon's centroid).
      const result = await resolvePointsToCommonAncestor(prisma, [
        { lat: AL_KURMUK_LAT, lng: AL_KURMUK_LNG },
        { lat: 10.526216818663212, lng: 34.112256392907 }, // Al Kurmuk centroid
      ]);
      expect(result?.level).toBe(2);
      expect(result?.name).toBe(AL_KURMUK_NAME);
    });

    it("falls back to A1 when points span two A2s in the same state", async () => {
      // Al Kurmuk and Baw are different A2s in Blue Nile state — no single A2
      // contains both, but Blue Nile (A1) does.
      const result = await resolvePointsToCommonAncestor(prisma, [
        { lat: AL_KURMUK_LAT, lng: AL_KURMUK_LNG },
        { lat: BAW_LAT, lng: BAW_LNG },
      ]);
      expect(result?.level).toBe(1);
      expect(result?.name).toBe(BLUE_NILE_NAME);
    });

    it("falls back to A0 when points span multiple states", async () => {
      // Al Kurmuk is in Blue Nile state, Khartoum is in Khartoum state —
      // only the country (Sudan, A0) contains both.
      const result = await resolvePointsToCommonAncestor(prisma, [
        { lat: AL_KURMUK_LAT, lng: AL_KURMUK_LNG },
        { lat: KHARTOUM_LAT, lng: KHARTOUM_LNG },
      ]);
      expect(result?.level).toBe(0);
      expect(result?.name).toBe(SUDAN_NAME);
    });

    it("ignores level-4 sibling rows even when they exist at the same coords", async () => {
      // Lock in the `level <= 2` filter — only proper admin polygons (A0/A1/A2)
      // are eligible as common ancestors, not previously-created L4 points.
      const poisonId = `test-l4-poison-multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdIds.push(poisonId);
      await prisma.$executeRaw`
        INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (
          ${poisonId},
          'TEST POISON L4 (multi-ancestor)',
          4,
          NULL,
          ARRAY[]::text[],
          ST_SetSRID(ST_MakePoint(${AL_KURMUK_LNG}, ${AL_KURMUK_LAT}), 4326)
        )
      `;

      const result = await resolvePointsToCommonAncestor(prisma, [
        { lat: AL_KURMUK_LAT, lng: AL_KURMUK_LNG },
      ]);
      // Single point delegates to resolveLatLngToLocation, which excludes L4.
      expect(result?.level).toBe(2);
      expect(result?.id).not.toBe(poisonId);
    });
  });
});
