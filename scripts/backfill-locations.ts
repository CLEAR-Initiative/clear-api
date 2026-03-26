/**
 * Backfill location_id on existing signals and events.
 *
 * Signals:
 *   - With lat/lng in raw_data → creates level-4 point location (child of resolved district)
 *   - Without lat/lng → text-matches title/description against known location names
 *
 * Events:
 *   - Single signal point → reuses that signal's location
 *   - Multiple signal points → creates level-4 convex hull region
 *   - No signal points → text-matches event title/description
 *
 * Usage:
 *   bunx tsx scripts/backfill-locations.ts
 *   bunx tsx scripts/backfill-locations.ts --dry-run   # Preview without writing
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { createPointLocation, createRegionFromPoints } from "../src/utils/geo-resolve.js";

const dryRun = process.argv.includes("--dry-run");

interface RawDataWithLocation {
  estimatedEventLocation?: {
    coordinates?: number[];
    name?: string;
  };
}

/** Try to find the most granular location whose name appears in the text. */
async function findLocationByTextMatch(text: string): Promise<{ id: string; name: string; level: number } | null> {
  const locations = await prisma.locations.findMany({
    select: { id: true, name: true, level: true },
    orderBy: { level: "desc" }, // most granular first (district > state > country)
  });
  for (const loc of locations) {
    if (text.includes(loc.name.toLowerCase())) {
      return loc;
    }
  }
  return null;
}

async function backfillSignals() {
  console.log("=== Backfilling signal locations ===");

  const signals = await prisma.signals.findMany({
    where: { locationId: null, originId: null, destinationId: null },
    select: { id: true, rawData: true, title: true, description: true },
  });

  console.log(`Found ${signals.length} signals with no location`);

  let resolved = 0;
  let failed = 0;

  for (const signal of signals) {
    const raw = signal.rawData as RawDataWithLocation | null;
    const coords = raw?.estimatedEventLocation?.coordinates;

    if (coords && coords.length >= 2) {
      // Has coordinates — create a level-4 point location
      const lat = coords[0]!;
      const lng = coords[1]!;
      const locName = raw?.estimatedEventLocation?.name ?? signal.title ?? undefined;

      if (!dryRun) {
        const pointLoc = await createPointLocation(prisma, lat, lng, locName);
        await prisma.signals.update({
          where: { id: signal.id },
          data: { locationId: pointLoc.id },
        });
        resolved++;
        console.log(`  ${signal.title ?? signal.id} → ${pointLoc.name} (level 4, point) [${lat}, ${lng}]`);
      } else {
        resolved++;
        console.log(`  [DRY] ${signal.title ?? signal.id} → would create point at (${lat}, ${lng})`);
      }
    } else {
      // No coordinates — text match fallback
      const textToSearch = `${signal.title ?? ""} ${signal.description ?? ""}`.toLowerCase();
      const matchedLoc = await findLocationByTextMatch(textToSearch);
      if (matchedLoc) {
        if (!dryRun) {
          await prisma.signals.update({
            where: { id: signal.id },
            data: { locationId: matchedLoc.id },
          });
        }
        resolved++;
        console.log(`  ${dryRun ? "[DRY] " : ""}${signal.title ?? signal.id} → ${matchedLoc.name} (level ${matchedLoc.level}) [text match]`);
      } else {
        const locName = raw?.estimatedEventLocation?.name ?? "no location data";
        failed++;
        console.log(`  SKIP: ${signal.title ?? signal.id} — ${locName} (no coordinates, no text match)`);
      }
    }
  }

  console.log(`Signals: ${resolved} resolved, ${failed} unresolved out of ${signals.length}`);
}

async function backfillEvents() {
  console.log("\n=== Backfilling event locations ===");

  const events = await prisma.events.findMany({
    where: { locationId: null, originId: null, destinationId: null },
    select: {
      id: true,
      title: true,
      description: true,
      signalEvents: {
        select: {
          signal: {
            select: { locationId: true, originId: true, destinationId: true },
          },
        },
      },
    },
  });

  console.log(`Found ${events.length} events with no location`);

  let resolved = 0;
  let failed = 0;

  for (const event of events) {
    // Collect all unique location IDs from linked signals
    const locIds = new Set<string>();
    for (const se of event.signalEvents) {
      if (se.signal.locationId) locIds.add(se.signal.locationId);
      if (se.signal.originId) locIds.add(se.signal.originId);
      if (se.signal.destinationId) locIds.add(se.signal.destinationId);
    }

    if (locIds.size === 0) {
      // No signal locations — try text match on event title/description
      const textToSearch = `${event.title ?? ""} ${event.description ?? ""}`.toLowerCase();
      const matchedLoc = await findLocationByTextMatch(textToSearch);
      if (matchedLoc) {
        if (!dryRun) {
          await prisma.events.update({
            where: { id: event.id },
            data: { locationId: matchedLoc.id },
          });
        }
        resolved++;
        console.log(`  ${dryRun ? "[DRY] " : ""}${event.title ?? event.id} → ${matchedLoc.name} (level ${matchedLoc.level}) [text match]`);
      } else {
        failed++;
        console.log(`  SKIP: ${event.title ?? event.id} — no signal locations, no text match`);
      }
      continue;
    }

    if (locIds.size === 1) {
      // Single location — reuse directly
      const locId = [...locIds][0]!;
      if (!dryRun) {
        await prisma.events.update({
          where: { id: event.id },
          data: { locationId: locId },
        });
      }
      resolved++;
      console.log(`  ${dryRun ? "[DRY] " : ""}${event.title ?? event.id} → reusing signal location ${locId}`);
      continue;
    }

    // Multiple locations — fetch point geometries and create a convex hull region
    const locPoints = await prisma.$queryRaw<Array<{ lat: number; lng: number }>>`
      SELECT ST_Y("geometry"::geometry) as lat, ST_X("geometry"::geometry) as lng
      FROM "locations"
      WHERE id = ANY(${[...locIds]}::text[])
        AND "geometry" IS NOT NULL
        AND ST_GeometryType("geometry"::geometry) = 'ST_Point'
    `;

    if (locPoints.length === 0) {
      // Signal locations exist but have no point geometry — use first location ID
      const locId = [...locIds][0]!;
      if (!dryRun) {
        await prisma.events.update({
          where: { id: event.id },
          data: { locationId: locId },
        });
      }
      resolved++;
      console.log(`  ${dryRun ? "[DRY] " : ""}${event.title ?? event.id} → fallback to first signal location ${locId}`);
    } else if (locPoints.length === 1) {
      const locId = [...locIds][0]!;
      if (!dryRun) {
        await prisma.events.update({
          where: { id: event.id },
          data: { locationId: locId },
        });
      }
      resolved++;
      console.log(`  ${dryRun ? "[DRY] " : ""}${event.title ?? event.id} → single point location`);
    } else {
      // Multiple points — create convex hull region
      if (!dryRun) {
        const region = await createRegionFromPoints(prisma, locPoints, event.title ?? undefined);
        await prisma.events.update({
          where: { id: event.id },
          data: { locationId: region.id },
        });
        resolved++;
        console.log(`  ${event.title ?? event.id} → region "${region.name}" (${locPoints.length} points)`);
      } else {
        resolved++;
        console.log(`  [DRY] ${event.title ?? event.id} → would create region from ${locPoints.length} points`);
      }
    }
  }

  console.log(`Events: ${resolved} resolved, ${failed} unresolved out of ${events.length}`);
}

async function main() {
  if (dryRun) console.log("*** DRY RUN — no changes will be written ***\n");

  await backfillSignals();
  await backfillEvents();

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
