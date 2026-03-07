import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { auth } from "../src/lib/auth.js";

async function seed() {
  console.log("Seeding database...\n");

  // ─── Clear existing data (dependency-safe order) ───────────────────────────
  await prisma.userAlert.deleteMany();
  await prisma.notifications.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.alertLocation.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.event.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.detectionLocation.deleteMany();
  await prisma.detection.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.dataSource.deleteMany();
  await prisma.location.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.verification.deleteMany();
  await prisma.user.deleteMany();
  console.log("Cleared existing data.");

  // ─── Users (via Better Auth) ───────────────────────────────────────────────
  const adminSignup = await auth.api.signUpEmail({
    body: { name: "Admin User", email: "admin@clear.dev", password: "password123" },
  });
  const admin = await prisma.user.update({
    where: { id: adminSignup.user.id },
    data: { role: "admin" },
  });

  const analystSignup = await auth.api.signUpEmail({
    body: { name: "Analyst User", email: "analyst@clear.dev", password: "password123" },
  });
  const analyst = await prisma.user.update({
    where: { id: analystSignup.user.id },
    data: { role: "analyst" },
  });

  const viewerSignup = await auth.api.signUpEmail({
    body: { name: "Viewer User", email: "viewer@clear.dev", password: "password123" },
  });
  const viewer = viewerSignup.user;

  console.log(`Created 3 users: admin (${admin.id}), analyst (${analyst.id}), viewer (${viewer.id})`);

  // ─── Locations (Sudan hierarchy: Country → State → Locality) ─────────────
  // Level 0: Country
  const sudan = await prisma.location.create({
    data: { geoId: "SD", name: "Sudan", level: 0 },
  });

  // Level 1: States
  const [khartoum, northDarfur, southDarfur, northKordofan] = await Promise.all([
    prisma.location.create({
      data: { geoId: "SD_001", name: "Khartoum", level: 1, parentId: sudan.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_002", name: "North Darfur", level: 1, parentId: sudan.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_003", name: "South Darfur", level: 1, parentId: sudan.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_004", name: "North Kordofan", level: 1, parentId: sudan.id, pointType: "CENTROID" },
    }),
  ]);

  // Level 2: Localities
  const [khartoumCity, omdurman, elFasher, kutum, nyala, elDaein] = await Promise.all([
    prisma.location.create({
      data: { geoId: "SD_001_001", name: "Khartoum City", level: 2, parentId: khartoum.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_001_002", name: "Omdurman", level: 2, parentId: khartoum.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_002_001", name: "El Fasher", level: 2, parentId: northDarfur.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_002_002", name: "Kutum", level: 2, parentId: northDarfur.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_003_001", name: "Nyala", level: 2, parentId: southDarfur.id, pointType: "CENTROID" },
    }),
    prisma.location.create({
      data: { geoId: "SD_003_002", name: "Ed Daein", level: 2, parentId: southDarfur.id, pointType: "CENTROID" },
    }),
  ]);

  // Set geographic data using raw SQL (Unsupported types can't be set via Prisma client)
  // Points (centroids) and simplified boundary polygons for states
  const geoUpdates = [
    // Sudan country centroid
    { id: sudan.id, lon: 30.0, lat: 15.5, boundary: null },
    // Khartoum state: centroid + simplified boundary
    {
      id: khartoum.id,
      lon: 32.53,
      lat: 15.55,
      boundary: `MULTIPOLYGON(((31.7 15.19, 34.38 15.19, 34.38 16.63, 31.7 16.63, 31.7 15.19)))`,
    },
    // North Darfur state: centroid + simplified boundary
    {
      id: northDarfur.id,
      lon: 25.09,
      lat: 15.45,
      boundary: `MULTIPOLYGON(((23.0 13.0, 27.5 13.0, 27.5 20.0, 23.0 20.0, 23.0 13.0)))`,
    },
    // South Darfur state: centroid + simplified boundary
    {
      id: southDarfur.id,
      lon: 25.0,
      lat: 11.5,
      boundary: `MULTIPOLYGON(((23.5 8.65, 27.5 8.65, 27.5 13.12, 23.5 13.12, 23.5 8.65)))`,
    },
    // North Kordofan state: centroid + simplified boundary
    {
      id: northKordofan.id,
      lon: 30.0,
      lat: 13.5,
      boundary: `MULTIPOLYGON(((27.5 12.0, 32.5 12.0, 32.5 16.0, 27.5 16.0, 27.5 12.0)))`,
    },
    // Localities (points only)
    { id: khartoumCity.id, lon: 32.56, lat: 15.59, boundary: null },
    { id: omdurman.id, lon: 32.48, lat: 15.64, boundary: null },
    { id: elFasher.id, lon: 25.35, lat: 13.63, boundary: null },
    { id: kutum.id, lon: 24.67, lat: 14.20, boundary: null },
    { id: nyala.id, lon: 24.88, lat: 12.05, boundary: null },
    { id: elDaein.id, lon: 26.13, lat: 11.46, boundary: null },
  ];

  for (const geo of geoUpdates) {
    // Set point (geography)
    await prisma.$executeRawUnsafe(
      `UPDATE "Location" SET "point" = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography WHERE "id" = $3`,
      geo.lon,
      geo.lat,
      geo.id,
    );

    // Set boundary (geometry) if provided
    if (geo.boundary) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Location" SET "boundary" = ST_GeomFromText($1, 4326) WHERE "id" = $2`,
        geo.boundary,
        geo.id,
      );
    }
  }

  console.log("Created 11 locations (1 country, 4 states, 6 localities) with geographic data");

  // ─── Data Sources ──────────────────────────────────────────────────────────
  const [socialMedia, newsApi, govReports] = await Promise.all([
    prisma.dataSource.create({
      data: {
        name: "Social Media Monitor",
        type: "social_media",
        isActive: true,
        baseUrl: "https://api.social-monitor.org/v2",
        infoUrl: "https://social-monitor.org",
      },
    }),
    prisma.dataSource.create({
      data: {
        name: "ACLED Conflict Data",
        type: "conflict_tracker",
        isActive: true,
        baseUrl: "https://acleddata.com/api/v3",
        infoUrl: "https://acleddata.com",
      },
    }),
    prisma.dataSource.create({
      data: {
        name: "FEWS NET",
        type: "food_security",
        isActive: true,
        baseUrl: "https://fews.net/api",
        infoUrl: "https://fews.net",
      },
    }),
  ]);

  console.log("Created 3 data sources");

  // ─── Detections ────────────────────────────────────────────────────────────
  const [det1, det2, det3, det4, det5, det6] = await Promise.all([
    prisma.detection.create({
      data: {
        title: "Armed clashes reported near El Fasher",
        confidence: 0.91,
        status: "processed",
        sourceId: newsApi.id,
        rawData: { events: 12, fatalities: "unknown", source: "ACLED" },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Displacement surge detected in South Darfur",
        confidence: 0.88,
        status: "processed",
        sourceId: socialMedia.id,
        rawData: { posts: 234, sentiment: "distress", hashtags: ["#Darfur", "#displacement"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Flood warnings along the Nile in Khartoum",
        confidence: 0.94,
        status: "processed",
        sourceId: socialMedia.id,
        rawData: { posts: 187, sentiment: "alarmed", hashtags: ["#KhartoumFloods", "#Nile"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Minor locust sighting in North Kordofan",
        confidence: 0.42,
        status: "raw",
        sourceId: govReports.id,
        rawData: { report_id: "FAO-2026-SD-047", agency: "FAO" },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Food insecurity escalation in Kutum locality",
        confidence: 0.85,
        status: "processed",
        sourceId: govReports.id,
        rawData: { ipc_phase: 4, report_id: "FEWSNET-2026-03", population_affected: "120K" },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Duplicate weather station reading - Omdurman",
        confidence: 0.25,
        status: "ignored",
        sourceId: socialMedia.id,
        rawData: { station: "SD-WX-0012", note: "sensor malfunction confirmed" },
      },
    }),
  ]);

  // Link detections to locations
  await Promise.all([
    prisma.detectionLocation.create({ data: { detectionId: det1.id, locationId: elFasher.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det1.id, locationId: northDarfur.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det2.id, locationId: nyala.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det2.id, locationId: southDarfur.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det3.id, locationId: khartoumCity.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det3.id, locationId: khartoum.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det4.id, locationId: northKordofan.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det5.id, locationId: kutum.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det5.id, locationId: northDarfur.id } }),
  ]);

  console.log("Created 6 detections with location links");

  // ─── Signals (1:1 with processed detections) ─────────────────────────────
  const [sig1, sig2, sig3, sig5] = await Promise.all([
    prisma.signal.create({ data: { detectionId: det1.id } }),
    prisma.signal.create({ data: { detectionId: det2.id } }),
    prisma.signal.create({ data: { detectionId: det3.id } }),
    prisma.signal.create({ data: { detectionId: det5.id } }),
  ]);

  console.log("Created 4 signals from processed detections");

  // ─── Events (group related signals) ──────────────────────────────────────
  const [evt1, evt2, evt3, evt4] = await Promise.all([
    prisma.event.create({
      data: {
        primarySignalId: sig1.id,
        signals: { connect: [{ id: sig1.id }] },
      },
    }),
    prisma.event.create({
      data: {
        primarySignalId: sig2.id,
        signals: { connect: [{ id: sig2.id }] },
      },
    }),
    prisma.event.create({
      data: {
        primarySignalId: sig3.id,
        signals: { connect: [{ id: sig3.id }] },
      },
    }),
    prisma.event.create({
      data: {
        primarySignalId: sig5.id,
        signals: { connect: [{ id: sig5.id }] },
      },
    }),
  ]);

  console.log("Created 4 events");

  // ─── Alerts ────────────────────────────────────────────────────────────────
  const [alert1, alert2, alert3, alert4] = await Promise.all([
    prisma.alert.create({
      data: {
        title: "Armed Conflict Escalation - El Fasher, North Darfur",
        description:
          "ACLED conflict data confirms intensified armed clashes in and around El Fasher. Civilian displacement ongoing. Humanitarian access severely constrained.",
        severity: 5,
        status: "published",
        sourceId: newsApi.id,
        createdById: admin.id,
        primaryEventId: evt1.id,
        events: { connect: [{ id: evt1.id }] },
        metadata: { category: "conflict", affectedPopulation: "500K+", ipcPhase: 4 },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Mass Displacement Alert - South Darfur",
        description:
          "Social media monitoring and ground reports indicate a significant surge in internal displacement in Nyala and surrounding areas. Emergency shelter and food assistance urgently needed.",
        severity: 4,
        status: "published",
        sourceId: socialMedia.id,
        createdById: analyst.id,
        primaryEventId: evt2.id,
        events: { connect: [{ id: evt2.id }] },
        metadata: { category: "displacement", estimatedIDPs: "75K" },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Nile Flood Warning - Khartoum State",
        description:
          "Rising Nile water levels threaten low-lying areas of Khartoum and Omdurman. Social media reports confirm water entering residential neighborhoods. Emergency flood response recommended.",
        severity: 4,
        status: "draft",
        sourceId: socialMedia.id,
        createdById: admin.id,
        primaryEventId: evt3.id,
        events: { connect: [{ id: evt3.id }] },
        metadata: { category: "flood", nileLevel: "17.5m", threshold: "17.0m" },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Food Insecurity Crisis - Kutum, North Darfur",
        description:
          "FEWS NET reports IPC Phase 4 (Emergency) food insecurity in Kutum locality. Approximately 120,000 people affected. Market prices for staple foods have doubled since last quarter.",
        severity: 3,
        status: "archived",
        sourceId: govReports.id,
        createdById: analyst.id,
        primaryEventId: evt4.id,
        events: { connect: [{ id: evt4.id }] },
        metadata: { category: "food_security", ipcPhase: 4, reportRef: "FEWSNET-2026-03" },
      },
    }),
  ]);

  // Link alerts to locations
  await Promise.all([
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: elFasher.id } }),
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: northDarfur.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: nyala.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: southDarfur.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: khartoumCity.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: khartoum.id } }),
    prisma.alertLocation.create({ data: { alertId: alert4.id, locationId: kutum.id } }),
    prisma.alertLocation.create({ data: { alertId: alert4.id, locationId: northDarfur.id } }),
  ]);

  console.log("Created 4 alerts with event and location links");

  // ─── User Feedback (UserAlert) ─────────────────────────────────────────────
  await Promise.all([
    prisma.userAlert.create({
      data: {
        userId: analyst.id,
        alertId: alert1.id,
        readAt: new Date(),
        rating: 5,
        comment: "Critical alert. ACLED data matches ground reports from our field team.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id,
        alertId: alert1.id,
        readAt: new Date(),
        rating: 4,
        comment: "Shared with our humanitarian coordination team in North Darfur.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id,
        alertId: alert2.id,
        readAt: new Date(),
        rating: 4,
        comment: "Displacement figures align with UNHCR preliminary estimates.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id,
        alertId: alert2.id,
        readAt: new Date(),
        rating: 3,
        comment: "Useful but would benefit from more granular location data.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id,
        alertId: alert4.id,
        readAt: new Date(),
        rating: 3,
        comment: "Good baseline data for food security monitoring. Archived for trend analysis.",
      },
    }),
  ]);

  console.log("Created 5 user feedback entries");

  // ─── Notifications ────────────────────────────────────────────────────────
  await Promise.all([
    prisma.notifications.create({
      data: {
        userId: analyst.id,
        message: "New conflict alert published for El Fasher, North Darfur",
        notificationType: "alert",
        actionUrl: `/alerts/${alert1.id}`,
        actionText: "View Alert",
        status: "READ",
      },
    }),
    prisma.notifications.create({
      data: {
        userId: viewer.id,
        message: "Flood warning drafted for Khartoum State",
        notificationType: "alert",
        actionUrl: `/alerts/${alert3.id}`,
        actionText: "View Alert",
        status: "DELIVERED",
      },
    }),
    prisma.notifications.create({
      data: {
        userId: admin.id,
        message: "Weekly system report is ready",
        notificationType: "system",
        status: "PENDING",
      },
    }),
  ]);

  console.log("Created 3 notifications");

  // ─── Feature Flags ─────────────────────────────────────────────────────────
  await Promise.all([
    prisma.featureFlag.create({ data: { key: "dark_mode", enabled: true } }),
    prisma.featureFlag.create({ data: { key: "new_dashboard", enabled: false } }),
    prisma.featureFlag.create({ data: { key: "ai_analysis", enabled: true } }),
    prisma.featureFlag.create({ data: { key: "export_csv", enabled: false } }),
  ]);

  console.log("Created 4 feature flags");

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\nSeed complete! Demo credentials:");
  console.log("  admin@clear.dev    / password123  (role: admin)");
  console.log("  analyst@clear.dev  / password123  (role: analyst)");
  console.log("  viewer@clear.dev   / password123  (role: viewer)");
}

seed()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
