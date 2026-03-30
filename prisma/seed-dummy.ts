/**
 * Generate dummy (isDummy=true) signals, events, and alerts for demo/testing.
 *
 * Generates ~100 signals clustered into ~40 events with ~18 alerts.
 * Does NOT wipe existing data — only adds new records.
 *
 * Usage:
 *   bunx tsx prisma/seed.ts --dummy
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";

// ─── Sudan location data for point generation ─────────────────────────────────

interface PointSpec {
  district: string;  // key to look up in locations table
  lat: number;
  lng: number;
  name: string;
}

// Approximate coordinates for Sudan districts/cities
const SUDAN_POINTS: PointSpec[] = [
  { district: "El Fasher", lat: 13.63, lng: 25.35, name: "El Fasher Market Area" },
  { district: "El Fasher", lat: 13.65, lng: 25.32, name: "El Fasher North Checkpoint" },
  { district: "El Fasher", lat: 13.61, lng: 25.38, name: "El Fasher East District" },
  { district: "Kutum", lat: 14.20, lng: 24.67, name: "Kutum-El Fasher Road" },
  { district: "Kutum", lat: 14.22, lng: 24.65, name: "Kutum Town Centre" },
  { district: "Nyala", lat: 12.05, lng: 24.88, name: "Nyala WFP Distribution Site" },
  { district: "Nyala", lat: 12.08, lng: 24.90, name: "Nyala Central Market" },
  { district: "Nyala", lat: 12.02, lng: 24.91, name: "Kalma Camp Sector 7" },
  { district: "Nyala", lat: 12.03, lng: 24.85, name: "Nyala South IDP Settlement" },
  { district: "El Geneina", lat: 13.45, lng: 22.45, name: "El Geneina Hospital Area" },
  { district: "El Geneina", lat: 13.47, lng: 22.43, name: "El Geneina Border Crossing" },
  { district: "Zalingei", lat: 12.91, lng: 23.47, name: "Zalingei IDP Camp" },
  { district: "Ed Daein", lat: 11.46, lng: 26.13, name: "Ed Daein Reception Centre" },
  { district: "Khartoum City", lat: 15.59, lng: 32.56, name: "Khartoum Central District" },
  { district: "Omdurman", lat: 15.64, lng: 32.48, name: "Omdurman Al-Murada" },
  { district: "Omdurman", lat: 15.66, lng: 32.45, name: "Omdurman Dar es-Salaam" },
  { district: "Bahri", lat: 15.65, lng: 32.55, name: "Khartoum North (Bahri)" },
  { district: "Kassala City", lat: 15.45, lng: 36.40, name: "Kassala Gash River Area" },
  { district: "Kassala City", lat: 15.47, lng: 36.38, name: "Kassala City Centre" },
  { district: "Wad Medani", lat: 14.40, lng: 33.52, name: "Wad Medani Reception Point" },
  { district: "Wad Medani", lat: 14.38, lng: 33.50, name: "Wad Medani South Road" },
  { district: "Port Sudan", lat: 19.62, lng: 37.22, name: "Port Sudan Aid Corridor" },
  { district: "Kadugli", lat: 11.01, lng: 29.72, name: "Kadugli Town" },
  { district: "El Obeid", lat: 13.18, lng: 30.22, name: "El Obeid Market" },
  { district: "Sennar City", lat: 13.55, lng: 33.63, name: "Sennar Blue Nile Bridge" },
];

// ─── Event templates ──────────────────────────────────────────────────────────

interface EventTemplate {
  titleTemplate: string;
  descriptionTemplate: string;
  types: string[];
  severityRange: [number, number];
  signalCount: [number, number]; // min, max signals per event
  alertProbability: number; // 0-1 chance of being promoted to alert
  alertStatus: "published" | "draft";
}

const EVENT_TEMPLATES: EventTemplate[] = [
  {
    titleTemplate: "Armed clashes reported near {location}",
    descriptionTemplate: "Armed clashes between SAF and RSF forces reported in {location} area. {casualty} casualties reported. Civilian population sheltering in place.",
    types: ["ba", "vc"],
    severityRange: [3, 5],
    signalCount: [2, 4],
    alertProbability: 0.6,
    alertStatus: "published",
  },
  {
    titleTemplate: "Humanitarian convoy disrupted near {location}",
    descriptionTemplate: "Armed actors disrupted humanitarian aid convoy near {location}. {vehicles} vehicles affected. WFP/ICRC operations temporarily suspended.",
    types: ["ce", "vc"],
    severityRange: [3, 5],
    signalCount: [2, 5],
    alertProbability: 0.7,
    alertStatus: "published",
  },
  {
    titleTemplate: "IDP displacement surge detected near {location}",
    descriptionTemplate: "Mass displacement following armed clashes near {location}. Estimated {displaced} families displaced. Emergency NFI kits and shelter needed.",
    types: ["ce", "pv"],
    severityRange: [3, 5],
    signalCount: [2, 4],
    alertProbability: 0.5,
    alertStatus: "published",
  },
  {
    titleTemplate: "Suspected cholera/AWD outbreak in {location}",
    descriptionTemplate: "Health alert: suspected acute watery diarrhea/cholera cases reported in {location}. {cases} cases suspected, WASH team mobilised.",
    types: ["ep"],
    severityRange: [3, 5],
    signalCount: [2, 4],
    alertProbability: 0.65,
    alertStatus: "published",
  },
  {
    titleTemplate: "Flash flooding impacts {location}",
    descriptionTemplate: "Flash flooding reported in {location} following heavy rainfall. {affected} people estimated affected. Infrastructure damage reported.",
    types: ["ff", "fl"],
    severityRange: [2, 4],
    signalCount: [2, 3],
    alertProbability: 0.4,
    alertStatus: "published",
  },
  {
    titleTemplate: "Fire in IDP camp near {location}",
    descriptionTemplate: "Large fire reported in IDP settlement near {location}. {shelters} shelters destroyed. Emergency water trucking requested.",
    types: ["fr"],
    severityRange: [2, 4],
    signalCount: [2, 3],
    alertProbability: 0.35,
    alertStatus: "published",
  },
  {
    titleTemplate: "Food price spike detected in {location} markets",
    descriptionTemplate: "Staple food prices in {location} markets at {multiplier}x pre-conflict levels. Market access impaired by armed actors.",
    types: ["fc"],
    severityRange: [2, 3],
    signalCount: [1, 3],
    alertProbability: 0.2,
    alertStatus: "draft",
  },
  {
    titleTemplate: "Explosive remnants threat near {location}",
    descriptionTemplate: "Reports of unexploded ordnance near {location}. Civilian movement restricted. Mine action team requested.",
    types: ["rv"],
    severityRange: [2, 4],
    signalCount: [1, 2],
    alertProbability: 0.25,
    alertStatus: "draft",
  },
  {
    titleTemplate: "Airstrike/bombardment reported in {location}",
    descriptionTemplate: "Aerial bombardment reported in {location}. {casualty} casualties confirmed. Civilian infrastructure damaged.",
    types: ["ba", "rv"],
    severityRange: [4, 5],
    signalCount: [3, 5],
    alertProbability: 0.8,
    alertStatus: "published",
  },
  {
    titleTemplate: "Unverified security incident near {location}",
    descriptionTemplate: "Unverified reports of security incident near {location}. Low confidence, single source. Monitoring for corroboration.",
    types: ["ot"],
    severityRange: [1, 2],
    signalCount: [1, 1],
    alertProbability: 0.0,
    alertStatus: "draft",
  },
];

const SIGNAL_TITLE_VARIANTS: Record<string, string[]> = {
  acled: [
    "ACLED data: {type} event recorded in {location}",
    "Armed conflict incident documented near {location}",
    "Political violence event logged: {location} area",
  ],
  dataminr: [
    "Social media reports: {summary} near {location}",
    "BREAKING: {summary} - multiple posts from {location}",
    "Trending: Reports of {summary} in {location} area",
  ],
  gdacs: [
    "GDACS alert: {type} warning issued for {location}",
    "Emergency alert level {level} - {location}",
    "Humanitarian alert: {type} situation in {location}",
  ],
  dtm: [
    "DTM mobility tracking: Population movement detected near {location}",
    "Displacement data: {displaced} individuals tracked from {location}",
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function dateInRange(startDaysAgo: number, endDaysAgo: number): Date {
  const now = Date.now();
  const start = now - startDaysAgo * 86400000;
  const end = now - endDaysAgo * 86400000;
  return new Date(start + Math.random() * (end - start));
}

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
  }
  return result;
}

// ─── Main seed function ───────────────────────────────────────────────────────

export async function seedDummyData() {
  console.log("=== Seeding dummy data (isDummy=true) ===");

  // Fetch existing data sources
  const dataSources = await prisma.dataSources.findMany();
  if (dataSources.length === 0) {
    throw new Error("No data sources found. Run full seed first.");
  }
  const sourceMap = new Map(dataSources.map((s) => [s.name, s.id]));
  const sourceNames = ["dataminr", "acled", "gdacs", "dtm"];
  const availableSources = sourceNames.filter((n) => sourceMap.has(n));
  if (availableSources.length === 0) {
    throw new Error("No recognized data sources (dataminr/acled/gdacs/dtm) found.");
  }

  // Fetch existing districts (level 2) for parenting point locations
  const districts = await prisma.locations.findMany({
    where: { level: 2 },
    select: { id: true, name: true, ancestorIds: true },
  });
  const districtMap = new Map(districts.map((d) => [d.name, d]));

  /**
   * Create a unique level-4 point location for a signal.
   * Applies a small random offset (~1-5km) around the base point
   * so each signal has its own distinct coordinates.
   */
  async function createSignalPointLocation(
    basePoint: PointSpec,
    label: string,
  ): Promise<{ id: string; lat: number; lng: number }> {
    const parent = districtMap.get(basePoint.district);
    const parentId = parent?.id ?? null;
    const ancestorIds = parent ? [parent.id, ...parent.ancestorIds] : [];
    const id = randomUUID();

    // Random offset: ~1-5km in each direction (roughly 0.01-0.05 degrees)
    const lat = basePoint.lat + (Math.random() - 0.5) * 0.08;
    const lng = basePoint.lng + (Math.random() - 0.5) * 0.08;

    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${id}, ${label}, 4, ${parentId}, ${ancestorIds}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    `;

    return { id, lat, lng };
  }

  // Generate events
  console.log("  Generating events and signals...");
  const TARGET_EVENTS = 40;
  const createdEvents: Array<{ id: string; types: string[]; severity: number; status: string }> = [];
  let totalSignals = 0;
  let totalPointLocations = 0;

  for (let i = 0; i < TARGET_EVENTS; i++) {
    const template = pick(EVENT_TEMPLATES);
    const basePoint = pick(SUDAN_POINTS);
    const severity = rand(template.severityRange[0], template.severityRange[1]);
    const eventDate = dateInRange(90, 1); // Last 90 days
    const signalCount = rand(template.signalCount[0], template.signalCount[1]);

    const vars = {
      location: basePoint.name,
      casualty: rand(1, 20),
      vehicles: rand(2, 8),
      displaced: rand(500, 15000),
      cases: rand(5, 80),
      affected: rand(1000, 10000),
      shelters: rand(50, 300),
      multiplier: (1.5 + Math.random() * 2).toFixed(1),
      level: pick(["Orange", "Red"]),
      type: template.types[0] ?? "crisis",
      summary: template.titleTemplate.replace("{location}", basePoint.district),
    };

    const eventTitle = fillTemplate(template.titleTemplate, vars);
    const eventDescription = fillTemplate(template.descriptionTemplate, vars);

    // Create signals first — each gets its own point location
    const signalIds: string[] = [];
    const signalLocationIds: string[] = [];
    const signalCoords: Array<{ lat: number; lng: number }> = [];

    for (let j = 0; j < signalCount; j++) {
      const sourceName = pick(availableSources);
      const sourceId = sourceMap.get(sourceName)!;
      const signalDate = new Date(eventDate.getTime() + rand(-2, 12) * 3600000);

      // Each signal gets a slightly different point near the event's base location
      const signalBasePoint = Math.random() > 0.3 ? basePoint : pick(SUDAN_POINTS);
      const signalLoc = await createSignalPointLocation(
        signalBasePoint,
        `Signal ${totalSignals + 1} — ${signalBasePoint.name}`,
      );
      totalPointLocations++;
      signalLocationIds.push(signalLoc.id);
      signalCoords.push({ lat: signalLoc.lat, lng: signalLoc.lng });

      const titleVariants = SIGNAL_TITLE_VARIANTS[sourceName] ?? [`Signal from ${sourceName}: Activity near {location}`];
      const signalTitle = fillTemplate(pick(titleVariants), {
        ...vars,
        location: signalBasePoint.name,
      });

      const signal = await prisma.signals.create({
        data: {
          sourceId,
          rawData: {
            isDummy: true,
            source: sourceName,
            eventIndex: i,
            signalIndex: j,
            generatedAt: new Date().toISOString(),
          },
          publishedAt: signalDate,
          collectedAt: signalDate,
          title: signalTitle,
          description: eventDescription,
          severity: rand(Math.max(1, severity - 1), Math.min(5, severity + 1)),
          locationId: signalLoc.id,
          isDummy: true,
        },
      });

      signalIds.push(signal.id);
      totalSignals++;
    }

    // Determine event location:
    //   1 signal  → reuse signal's point location (level 4)
    //   N signals → create a region (level 3) as a convex hull of signal points
    let eventLocationId: string;

    if (signalLocationIds.length === 1) {
      eventLocationId = signalLocationIds[0]!;
    } else {
      // Build MULTIPOINT WKT from signal coordinates and create a level-3 region
      const pointsWkt = signalCoords.map((c) => `${c.lng} ${c.lat}`).join(",");
      const regionId = randomUUID();
      const regionName = `${basePoint.district} — Event ${i + 1} region`;

      // Parent to the district
      const parent = districtMap.get(basePoint.district);
      const parentId = parent?.id ?? null;
      const ancestorIds = parent ? [parent.id, ...parent.ancestorIds] : [];

      await prisma.$executeRaw`
        INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
        VALUES (
          ${regionId}, ${regionName}, 3, ${parentId}, ${ancestorIds},
          ST_ConvexHull(ST_GeomFromText(${"MULTIPOINT(" + pointsWkt + ")"}, 4326))
        )
      `;
      totalPointLocations++;
      eventLocationId = regionId;
    }

    // Create event
    const createdEvent = await prisma.events.create({
      data: {
        title: eventTitle,
        description: eventDescription,
        validFrom: eventDate,
        validTo: new Date(eventDate.getTime() + 7 * 86400000),
        firstSignalCreatedAt: eventDate,
        lastSignalCreatedAt: new Date(eventDate.getTime() + rand(0, 48) * 3600000),
        types: template.types,
        severity,
        rank: severity / 5,
        locationId: eventLocationId,
        isDummy: true,
      },
    });

    // Link signals to event
    await prisma.signalEvents.createMany({
      data: signalIds.map((signalId) => ({
        signalId,
        eventId: createdEvent.id,
        collectedAt: eventDate,
      })),
    });

    createdEvents.push({
      id: createdEvent.id,
      types: template.types,
      severity,
      status: template.alertStatus,
    });
  }

  console.log(`  Created ${TARGET_EVENTS} events with ${totalSignals} signals (${totalPointLocations} point locations)`);

  // Create alerts from high-severity events
  console.log("  Creating alerts...");
  let alertCount = 0;

  for (const evt of createdEvents) {
    const template = EVENT_TEMPLATES.find((t) =>
      t.types.some((type) => evt.types.includes(type)),
    );
    if (!template) continue;

    if (Math.random() < template.alertProbability) {
      await prisma.alerts.create({
        data: {
          eventId: evt.id,
          status: evt.severity >= 4 ? "published" : template.alertStatus,
        },
      });
      alertCount++;
    }
  }

  console.log(`  Created ${alertCount} alerts`);
  console.log(`\n=== Dummy seed complete: ${totalPointLocations} locations, ${totalSignals} signals, ${TARGET_EVENTS} events, ${alertCount} alerts ===`);
}
