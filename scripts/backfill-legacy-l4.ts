/**
 * Backfill: remove legacy signal-title L4 locations.
 *
 * Identifies level-4 location rows whose `name` looks like a signal
 * headline rather than a place — left over from when the pipeline used
 * signal titles as the L4 name (e.g. "Drone strike on hospital:
 * Reuters via Telegram."). For each one:
 *
 *   1. For every signal whose location_id / origin_id / destination_id
 *      points at the legacy row:
 *        - If the signal has cached `geoparsed_data`, rebind to a
 *          landmark/admin L4 via `findOrCreateLandmarkL4` (creates a
 *          properly-named row tagged `landmark-geocoded`, or reuses an
 *          existing one in the same A2).
 *        - Otherwise rebind to a coord-named L4 (`Point lat, lng`) via
 *          `createPointLocation`, using the legacy L4's own geometry
 *          as the source coordinate.
 *
 *   2. For every event / crisis pointing at the legacy row in any of
 *      its location fields, rebind to the legacy L4's parent (the
 *      smallest containing A2 / A1 / A0). Less granular but never
 *      wrong — events and crises should never have been at L4 anyway.
 *
 *   3. Delete the legacy L4 row.
 *
 * What this script does NOT do
 *   - Does not call Nominatim. The signals that ended up on legacy
 *     headline L4s are exactly the ones where the geoparser missed at
 *     ingestion; re-running it would mostly produce the same misses
 *     and burn Nominatim quota. If you want a true fresh geoparse pass
 *     later, clear `signal.geoparsedData` for the affected ids and
 *     re-feed them through the pipeline.
 *
 * Usage
 *   bunx tsx scripts/backfill-legacy-l4.ts                  # dry-run summary
 *   bunx tsx scripts/backfill-legacy-l4.ts --apply          # actually write
 *   bunx tsx scripts/backfill-legacy-l4.ts --limit=10       # cap legacy L4s touched
 *   bunx tsx scripts/backfill-legacy-l4.ts --legacy-id=ID   # one row only
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import {
  createPointLocation,
  findOrCreateLandmarkL4,
} from "../src/utils/geo-resolve.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const limitFlag = argv.find((a) => a.startsWith("--limit="));
const idFlag = argv.find((a) => a.startsWith("--legacy-id="));
const limit = limitFlag ? Number(limitFlag.split("=")[1]) : null;
const targetId = idFlag ? idFlag.split("=")[1] : null;

if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
  console.error(`Invalid --limit value: ${limitFlag}`);
  process.exit(1);
}

/** Same predicate used at runtime in `createPointLocation` reuse. */
const LEGACY_NAME_PREDICATE = `
  level = 4
  AND (
    LENGTH(name) > 80
    OR name LIKE '%: %'
    OR name LIKE '% via %'
  )
`;

interface LegacyRow {
  id: string;
  name: string;
  parent_id: string | null;
  lat: number | null;
  lng: number | null;
}

interface SignalRef {
  id: string;
  locationId: string | null;
  originId: string | null;
  destinationId: string | null;
  geoparsedData: GeoparsedData | null;
}

interface GeoparsedData {
  candidate?: string;
  kind?: string;
  lat?: number;
  lng?: number;
}

interface EventRef {
  id: string;
  locationId: string | null;
  originId: string | null;
  destinationId: string | null;
}

interface CrisisRef {
  id: string;
  locationId: string | null;
}

async function findLegacyL4s(): Promise<LegacyRow[]> {
  if (targetId) {
    return prisma.$queryRawUnsafe<LegacyRow[]>(
      `
      SELECT id, name, parent_id,
             ST_Y("geometry"::geometry) AS lat,
             ST_X("geometry"::geometry) AS lng
      FROM "locations"
      WHERE id = $1 AND ${LEGACY_NAME_PREDICATE}
      `,
      targetId,
    );
  }
  const limitClause = limit !== null ? `LIMIT ${limit}` : "";
  return prisma.$queryRawUnsafe<LegacyRow[]>(`
    SELECT id, name, parent_id,
           ST_Y("geometry"::geometry) AS lat,
           ST_X("geometry"::geometry) AS lng
    FROM "locations"
    WHERE ${LEGACY_NAME_PREDICATE}
    ORDER BY LENGTH(name) DESC
    ${limitClause}
  `);
}

async function findSignalsReferencing(legacyId: string): Promise<SignalRef[]> {
  const rows = await prisma.signals.findMany({
    where: {
      OR: [
        { locationId: legacyId },
        { originId: legacyId },
        { destinationId: legacyId },
      ],
    },
    select: {
      id: true,
      locationId: true,
      originId: true,
      destinationId: true,
      geoparsedData: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    locationId: r.locationId,
    originId: r.originId,
    destinationId: r.destinationId,
    geoparsedData: (r.geoparsedData as GeoparsedData | null) ?? null,
  }));
}

async function findEventsReferencing(legacyId: string): Promise<EventRef[]> {
  return prisma.events.findMany({
    where: {
      OR: [
        { locationId: legacyId },
        { originId: legacyId },
        { destinationId: legacyId },
      ],
    },
    select: { id: true, locationId: true, originId: true, destinationId: true },
  });
}

async function findCrisesReferencing(legacyId: string): Promise<CrisisRef[]> {
  return prisma.crises.findMany({
    where: { locationId: legacyId },
    select: { id: true, locationId: true },
  });
}

/**
 * Choose the rebind target for one signal-location field. Returns
 * either an existing/new landmark L4 (when the signal carries cached
 * geoparser output we can trust) or a coord-named point L4 (when it
 * doesn't). Falls through to the coord-named L4 if the landmark path
 * aborts (e.g. different_a2 mismatch).
 */
async function resolveRebindTarget(
  signal: SignalRef,
  legacyLat: number,
  legacyLng: number,
): Promise<{ id: string; via: "landmark" | "point" }> {
  const g = signal.geoparsedData;
  if (
    g &&
    typeof g.candidate === "string" &&
    typeof g.lat === "number" &&
    typeof g.lng === "number" &&
    (g.kind === "landmark" || g.kind === "admin")
  ) {
    const result = await findOrCreateLandmarkL4(prisma, {
      name: g.candidate,
      lat: g.lat,
      lng: g.lng,
      kind: g.kind,
      sourceLat: legacyLat,
      sourceLng: legacyLng,
    });
    if (result.locationId) {
      return { id: result.locationId, via: "landmark" };
    }
    // different_a2 — fall through to coord-only target.
  }
  const point = await createPointLocation(prisma, legacyLat, legacyLng);
  return { id: point.id, via: "point" };
}

interface PerLegacyStats {
  legacyId: string;
  legacyName: string;
  signals: number;
  events: number;
  crises: number;
  rebindsViaLandmark: number;
  rebindsViaPoint: number;
  parentFallback: string | null;
}

async function processLegacy(row: LegacyRow): Promise<PerLegacyStats> {
  const stats: PerLegacyStats = {
    legacyId: row.id,
    legacyName: row.name,
    signals: 0,
    events: 0,
    crises: 0,
    rebindsViaLandmark: 0,
    rebindsViaPoint: 0,
    parentFallback: row.parent_id,
  };

  const [signals, events, crises] = await Promise.all([
    findSignalsReferencing(row.id),
    findEventsReferencing(row.id),
    findCrisesReferencing(row.id),
  ]);
  stats.signals = signals.length;
  stats.events = events.length;
  stats.crises = crises.length;

  if (!apply) return stats;

  if (row.lat == null || row.lng == null) {
    console.warn(
      `  [skip] ${row.id} has no geometry — cannot derive source coords. Manual review needed.`,
    );
    return stats;
  }

  for (const signal of signals) {
    // Choose a target per location field. We resolve once per field so a
    // signal whose origin and destination both pointed at the legacy row
    // doesn't end up with both bound to the same new L4 — though in
    // practice they always do (legacy rows hold a single point), and the
    // landmark/point dedup paths collapse them back to one row anyway.
    const data: {
      locationId?: string;
      originId?: string;
      destinationId?: string;
    } = {};
    if (signal.locationId === row.id) {
      const t = await resolveRebindTarget(signal, row.lat, row.lng);
      data.locationId = t.id;
      stats[t.via === "landmark" ? "rebindsViaLandmark" : "rebindsViaPoint"]++;
    }
    if (signal.originId === row.id) {
      const t = await resolveRebindTarget(signal, row.lat, row.lng);
      data.originId = t.id;
      stats[t.via === "landmark" ? "rebindsViaLandmark" : "rebindsViaPoint"]++;
    }
    if (signal.destinationId === row.id) {
      const t = await resolveRebindTarget(signal, row.lat, row.lng);
      data.destinationId = t.id;
      stats[t.via === "landmark" ? "rebindsViaLandmark" : "rebindsViaPoint"]++;
    }
    await prisma.signals.update({ where: { id: signal.id }, data });
  }

  // Events / crises: rebind to the legacy L4's parent (smallest A2/A1/A0
  // that contained it). Null parent → set to null (orphans the event at
  // the geographic level, which is what `onDelete: SetNull` would do
  // anyway — but doing it explicitly keeps the delete predictable).
  for (const event of events) {
    const data: {
      locationId?: string | null;
      originId?: string | null;
      destinationId?: string | null;
    } = {};
    if (event.locationId === row.id) data.locationId = row.parent_id;
    if (event.originId === row.id) data.originId = row.parent_id;
    if (event.destinationId === row.id) data.destinationId = row.parent_id;
    await prisma.events.update({ where: { id: event.id }, data });
  }
  for (const crisis of crises) {
    await prisma.crises.update({
      where: { id: crisis.id },
      data: { locationId: row.parent_id },
    });
  }

  // Now safe to delete — nothing should reference this row. We still
  // wrap in a try/catch so the script doesn't abort the whole run on a
  // single FK surprise (e.g. a reference we didn't anticipate).
  try {
    await prisma.$executeRaw`DELETE FROM "locations" WHERE id = ${row.id}`;
  } catch (err) {
    console.error(
      `  [delete-failed] ${row.id}: ${(err as Error).message}. Refs were rebound; manually inspect remaining references.`,
    );
  }

  return stats;
}

async function main() {
  console.log(
    `=== Legacy signal-title L4 backfill ===\n` +
      `Mode: ${apply ? "APPLY (writes will be committed)" : "DRY-RUN (no writes)"}\n` +
      (limit !== null ? `Limit: ${limit}\n` : "") +
      (targetId ? `Target id: ${targetId}\n` : ""),
  );

  const legacy = await findLegacyL4s();
  console.log(`Found ${legacy.length} legacy L4 row(s) matching the predicate.\n`);

  if (legacy.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // Pre-flight summary: print the worst offenders so the operator can
  // eyeball whether the predicate looks right before applying.
  console.log("Sample (longest names first):");
  for (const row of legacy.slice(0, 5)) {
    const preview = row.name.length > 100 ? row.name.slice(0, 97) + "…" : row.name;
    console.log(`  ${row.id}  [${row.name.length} chars]  ${preview}`);
  }
  console.log();

  const totals = {
    legacy: 0,
    signals: 0,
    events: 0,
    crises: 0,
    rebindsViaLandmark: 0,
    rebindsViaPoint: 0,
  };

  for (const row of legacy) {
    const s = await processLegacy(row);
    totals.legacy++;
    totals.signals += s.signals;
    totals.events += s.events;
    totals.crises += s.crises;
    totals.rebindsViaLandmark += s.rebindsViaLandmark;
    totals.rebindsViaPoint += s.rebindsViaPoint;
    if (s.signals + s.events + s.crises > 0) {
      console.log(
        `  ${row.id}  signals=${s.signals}  events=${s.events}  crises=${s.crises}` +
          (apply
            ? `  rebinds(landmark/point)=${s.rebindsViaLandmark}/${s.rebindsViaPoint}`
            : ""),
      );
    }
  }

  console.log(
    `\n=== Summary ===\n` +
      `Legacy L4 rows:      ${totals.legacy}\n` +
      `Signals affected:    ${totals.signals}\n` +
      `Events affected:     ${totals.events}\n` +
      `Crises affected:     ${totals.crises}\n` +
      (apply
        ? `Signal rebinds:      ${totals.rebindsViaLandmark} via landmark, ${totals.rebindsViaPoint} via point\n` +
          `Legacy rows deleted: ${totals.legacy} (modulo any [delete-failed] above)\n`
        : `Run again with --apply to commit these changes.\n`),
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
