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
  await prisma.event.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.sourceLocation.deleteMany();
  await prisma.source.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.dataSource.deleteMany();
  await prisma.location.deleteMany();
  await prisma.organisationUser.deleteMany();
  await prisma.organisation.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.verification.deleteMany();
  await prisma.user.deleteMany();
  console.log("Cleared existing data.");

  // ─── Users (via Better Auth) ───────────────────────────────────────────────
  const adminSignup = await auth.api.signUpEmail({
    body: { name: "Admin User", email: "admin@clear.dev", password: "password123" },
  });
  const admin = adminSignup.user;

  const analystSignup = await auth.api.signUpEmail({
    body: { name: "Analyst User", email: "analyst@clear.dev", password: "password123" },
  });
  const analyst = analystSignup.user;

  const viewerSignup = await auth.api.signUpEmail({
    body: { name: "Viewer User", email: "viewer@clear.dev", password: "password123" },
  });
  const viewer = viewerSignup.user;

  // ─── Organisation & Roles ─────────────────────────────────────────────────
  const org = await prisma.organisation.create({
    data: { name: "CLEAR Platform" },
  });

  await Promise.all([
    prisma.organisationUser.create({
      data: { userId: admin.id, organisationId: org.id, role: "admin" },
    }),
    prisma.organisationUser.create({
      data: { userId: analyst.id, organisationId: org.id, role: "analyst" },
    }),
    prisma.organisationUser.create({
      data: { userId: viewer.id, organisationId: org.id, role: "viewer" },
    }),
  ]);

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
  const geoUpdates = [
    { id: sudan.id, lon: 30.0, lat: 15.5, boundary: null },
    {
      id: khartoum.id, lon: 32.53, lat: 15.55,
      boundary: `MULTIPOLYGON(((31.7 15.19, 34.38 15.19, 34.38 16.63, 31.7 16.63, 31.7 15.19)))`,
    },
    {
      id: northDarfur.id, lon: 25.09, lat: 15.45,
      boundary: `MULTIPOLYGON(((23.0 13.0, 27.5 13.0, 27.5 20.0, 23.0 20.0, 23.0 13.0)))`,
    },
    {
      id: southDarfur.id, lon: 25.0, lat: 11.5,
      boundary: `MULTIPOLYGON(((23.5 8.65, 27.5 8.65, 27.5 13.12, 23.5 13.12, 23.5 8.65)))`,
    },
    {
      id: northKordofan.id, lon: 30.0, lat: 13.5,
      boundary: `MULTIPOLYGON(((27.5 12.0, 32.5 12.0, 32.5 16.0, 27.5 16.0, 27.5 12.0)))`,
    },
    { id: khartoumCity.id, lon: 32.56, lat: 15.59, boundary: null },
    { id: omdurman.id, lon: 32.48, lat: 15.64, boundary: null },
    { id: elFasher.id, lon: 25.35, lat: 13.63, boundary: null },
    { id: kutum.id, lon: 24.67, lat: 14.20, boundary: null },
    { id: nyala.id, lon: 24.88, lat: 12.05, boundary: null },
    { id: elDaein.id, lon: 26.13, lat: 11.46, boundary: null },
  ];

  for (const geo of geoUpdates) {
    await prisma.$executeRawUnsafe(
      `UPDATE "location" SET "point" = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography WHERE "id" = $3`,
      geo.lon, geo.lat, geo.id,
    );
    if (geo.boundary) {
      await prisma.$executeRawUnsafe(
        `UPDATE "location" SET "boundary" = ST_GeomFromText($1, 4326) WHERE "id" = $2`,
        geo.boundary, geo.id,
      );
    }
  }

  console.log("Created 11 locations (1 country, 4 states, 6 localities) with geographic data");

  // ─── Data Sources ──────────────────────────────────────────────────────────
  const [socialMedia, acled, fewsNet] = await Promise.all([
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

  // ─── Sources (raw data items from data sources) ───────────────────────────
  // Each source is an independent raw record from a data source.
  // The pipeline promotes them: Source → Signal → Event (→ Alert via isAlert)
  const now = new Date();
  const [src1, src2, src3, src4, src5, src6, src7, src8, src9, src10] = await Promise.all([
    // Darfur conflict cluster
    prisma.source.create({
      data: {
        title: "Armed clashes reported near El Fasher",
        confidence: 0.91, status: "processed", dataSourceId: acled.id,
        rawData: { events: 12, fatalities: "unknown", source: "ACLED" },
      },
    }),
    prisma.source.create({
      data: {
        title: "RSF troop movements detected in North Darfur",
        confidence: 0.87, status: "processed", dataSourceId: socialMedia.id,
        rawData: { posts: 156, sentiment: "fear", hashtags: ["#RSF", "#Darfur"] },
      },
    }),
    // Displacement cluster
    prisma.source.create({
      data: {
        title: "Displacement surge detected in South Darfur",
        confidence: 0.88, status: "processed", dataSourceId: socialMedia.id,
        rawData: { posts: 234, sentiment: "distress", hashtags: ["#Darfur", "#displacement"] },
      },
    }),
    prisma.source.create({
      data: {
        title: "IDP camp overcrowding reported in Nyala",
        confidence: 0.82, status: "processed", dataSourceId: fewsNet.id,
        rawData: { camp: "Kalma", capacity_pct: 187, report_id: "OCHA-2026-SD-019" },
      },
    }),
    // Khartoum flood cluster
    prisma.source.create({
      data: {
        title: "Flood warnings along the Nile in Khartoum",
        confidence: 0.94, status: "processed", dataSourceId: socialMedia.id,
        rawData: { posts: 187, sentiment: "alarmed", hashtags: ["#KhartoumFloods", "#Nile"] },
      },
    }),
    prisma.source.create({
      data: {
        title: "Bridge damage reported in Omdurman",
        confidence: 0.79, status: "processed", dataSourceId: socialMedia.id,
        rawData: { posts: 98, images: 12, location: "White Nile Bridge" },
      },
    }),
    // Food security cluster
    prisma.source.create({
      data: {
        title: "Food insecurity escalation in Kutum locality",
        confidence: 0.85, status: "processed", dataSourceId: fewsNet.id,
        rawData: { ipc_phase: 4, report_id: "FEWSNET-2026-03", population_affected: "120K" },
      },
    }),
    prisma.source.create({
      data: {
        title: "Staple food price spikes across North Darfur markets",
        confidence: 0.80, status: "processed", dataSourceId: fewsNet.id,
        rawData: { sorghum_pct_increase: 112, millet_pct_increase: 95, period: "Q1 2026" },
      },
    }),
    // Unprocessed / ignored sources (not promoted to signals)
    prisma.source.create({
      data: {
        title: "Minor locust sighting in North Kordofan",
        confidence: 0.42, status: "raw", dataSourceId: fewsNet.id,
        rawData: { report_id: "FAO-2026-SD-047", agency: "FAO" },
      },
    }),
    prisma.source.create({
      data: {
        title: "Duplicate weather station reading - Omdurman",
        confidence: 0.25, status: "ignored", dataSourceId: socialMedia.id,
        rawData: { station: "SD-WX-0012", note: "sensor malfunction confirmed" },
      },
    }),
  ]);

  // Link sources to locations
  await Promise.all([
    prisma.sourceLocation.create({ data: { sourceId: src1.id, locationId: elFasher.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src1.id, locationId: northDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src2.id, locationId: northDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src3.id, locationId: nyala.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src3.id, locationId: southDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src4.id, locationId: nyala.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src4.id, locationId: southDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src5.id, locationId: khartoumCity.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src5.id, locationId: khartoum.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src6.id, locationId: omdurman.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src6.id, locationId: khartoum.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src7.id, locationId: kutum.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src7.id, locationId: northDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src8.id, locationId: northDarfur.id } }),
    prisma.sourceLocation.create({ data: { sourceId: src9.id, locationId: northKordofan.id } }),
  ]);

  console.log("Created 10 sources with location links");

  // ─── Signals (1:1 with processed sources) ─────────────────────────────────
  // Only processed sources are promoted to signals
  const [sig1, sig2, sig3, sig4, sig5, sig6, sig7, sig8] = await Promise.all([
    prisma.signal.create({ data: { sourceId: src1.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src2.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src3.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src4.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src5.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src6.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src7.id, publishedAt: now, collectedAt: now } }),
    prisma.signal.create({ data: { sourceId: src8.id, publishedAt: now, collectedAt: now } }),
  ]);

  console.log("Created 8 signals from processed sources");

  // ─── Events (group related signals into coherent events) ─────────────────
  // Each event groups signals that describe the same real-world situation.
  // Events with isAlert=true are elevated to actionable alerts.
  const evtDarfurConflict = await prisma.event.create({
    data: {
      primarySignalId: sig1.id,
      signals: { connect: [{ id: sig1.id }, { id: sig2.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "conflict",
      rank: 0.91,
      severity: 3,
      status: "published",
      description: "Armed clashes and RSF troop movements detected across North Darfur",
    },
  });

  const evtDisplacement = await prisma.event.create({
    data: {
      primarySignalId: sig3.id,
      signals: { connect: [{ id: sig3.id }, { id: sig4.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "displacement",
      rank: 0.85,
      severity: 3,
      status: "published",
      description: "Displacement surge in South Darfur with IDP camp overcrowding",
    },
  });

  const evtKhartoumFlood = await prisma.event.create({
    data: {
      primarySignalId: sig5.id,
      signals: { connect: [{ id: sig5.id }, { id: sig6.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "natural_disaster",
      rank: 0.87,
      severity: 2,
      status: "published",
      description: "Nile flooding threatening Khartoum and Omdurman with bridge damage reported",
    },
  });

  const evtFoodCrisis = await prisma.event.create({
    data: {
      primarySignalId: sig7.id,
      signals: { connect: [{ id: sig7.id }, { id: sig8.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "food_security",
      rank: 0.82,
      severity: 3,
      status: "published",
      description: "Food insecurity escalation with price spikes across North Darfur",
    },
  });

  console.log("Created 4 events (each grouping 2 related signals)");

  // ─── Alerts (events elevated to actionable alerts via isAlert) ─────────────
  // Alerts are events with isAlert=true, carrying additional severity/metadata.

  // Alert 1: Darfur Humanitarian Crisis
  const alert1 = await prisma.event.create({
    data: {
      primarySignalId: sig1.id,
      signals: { connect: [{ id: sig1.id }, { id: sig2.id }, { id: sig3.id }, { id: sig4.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "compound_crisis",
      rank: 0.95,
      severity: 5,
      status: "published",
      isAlert: true,
      description:
        "Multiple correlated events indicate an escalating humanitarian crisis across Darfur. " +
        "ACLED data confirms intensified armed clashes and RSF troop movements in North Darfur (El Fasher), " +
        "while social media and OCHA reports show a resulting displacement surge in South Darfur (Nyala, Kalma camp at 187% capacity). " +
        "These events are causally linked — the conflict is driving civilian displacement across state lines.",
      metadata: {
        category: "compound_crisis",
        signalCount: 4,
        affectedPopulation: "500K+",
        triggerChain: "conflict → displacement",
      },
    },
  });

  // Alert 2: Khartoum Flood Emergency
  const alert2 = await prisma.event.create({
    data: {
      primarySignalId: sig5.id,
      signals: { connect: [{ id: sig5.id }, { id: sig6.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "natural_disaster",
      rank: 0.90,
      severity: 4,
      status: "published",
      isAlert: true,
      description:
        "Rising Nile water levels threaten low-lying areas of Khartoum and Omdurman. " +
        "Social media reports confirm flooding in residential neighborhoods and structural damage to the White Nile Bridge. " +
        "Emergency flood response recommended for Khartoum City and Omdurman.",
      metadata: {
        category: "natural_disaster",
        signalCount: 2,
        nileLevel: "17.5m",
        threshold: "17.0m",
      },
    },
  });

  // Alert 3: North Darfur Compound Crisis (draft)
  const alert3 = await prisma.event.create({
    data: {
      primarySignalId: sig7.id,
      signals: { connect: [{ id: sig1.id }, { id: sig2.id }, { id: sig7.id }, { id: sig8.id }] },
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      eventType: "compound_crisis",
      rank: 0.93,
      severity: 5,
      status: "draft",
      isAlert: true,
      description:
        "Conflict in North Darfur is compounding a food security emergency. " +
        "FEWS NET reports IPC Phase 4 (Emergency) in Kutum locality with 120K people affected, " +
        "while staple food prices have more than doubled. Armed clashes and RSF troop movements " +
        "are disrupting market access and humanitarian supply routes across the state.",
      metadata: {
        category: "compound_crisis",
        signalCount: 4,
        ipcPhase: 4,
        triggerChain: "conflict → market disruption → food insecurity",
        reportRef: "FEWSNET-2026-03",
      },
    },
  });

  // Link alerts to locations
  await Promise.all([
    // Alert 1 spans North Darfur (conflict) + South Darfur (displacement)
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: elFasher.id } }),
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: northDarfur.id } }),
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: nyala.id } }),
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: southDarfur.id } }),
    // Alert 2 covers Khartoum state
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: khartoumCity.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: omdurman.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: khartoum.id } }),
    // Alert 3 spans North Darfur (conflict + food)
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: elFasher.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: kutum.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: northDarfur.id } }),
  ]);

  console.log("Created 3 alerts (events with isAlert=true) + 4 regular events:");
  console.log("  Alert 1: compound crisis (conflict + displacement) → 4 signals");
  console.log("  Alert 2: natural disaster (flooding) → 2 signals");
  console.log("  Alert 3: compound crisis (conflict + food) → 4 signals (draft)");

  // ─── User Feedback (UserAlert) ─────────────────────────────────────────────
  await Promise.all([
    prisma.userAlert.create({
      data: {
        userId: analyst.id, alertId: alert1.id,
        readAt: new Date(), rating: 5,
        comment: "Excellent compound alert. The conflict-displacement causal link is well supported by the underlying signals.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id, alertId: alert1.id,
        readAt: new Date(), rating: 4,
        comment: "Shared with our humanitarian coordination team in Darfur. The multi-event aggregation is very useful.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id, alertId: alert2.id,
        readAt: new Date(), rating: 4,
        comment: "Bridge damage signal was a good addition — it shows infrastructure impact beyond just water levels.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id, alertId: alert2.id,
        readAt: new Date(), rating: 3,
        comment: "Useful but would benefit from satellite imagery to verify extent of flooding.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id, alertId: alert3.id,
        rating: 4,
        comment: "Strong analysis linking conflict to food insecurity.",
      },
    }),
  ]);

  console.log("Created 5 user feedback entries");

  // ─── Notifications ────────────────────────────────────────────────────────
  await Promise.all([
    prisma.notifications.create({
      data: {
        userId: analyst.id,
        message: "New compound alert published: Darfur Humanitarian Crisis",
        notificationType: "alert",
        actionUrl: `/alerts/${alert1.id}`,
        actionText: "View Alert",
        status: "READ",
      },
    }),
    prisma.notifications.create({
      data: {
        userId: viewer.id,
        message: "Khartoum flood alert published with 2 corroborating signals",
        notificationType: "alert",
        actionUrl: `/alerts/${alert2.id}`,
        actionText: "View Alert",
        status: "DELIVERED",
      },
    }),
    prisma.notifications.create({
      data: {
        userId: admin.id,
        message: "Draft alert ready for review: North Darfur compound crisis (conflict + food insecurity)",
        notificationType: "alert",
        actionUrl: `/alerts/${alert3.id}`,
        actionText: "Review Alert",
        status: "PENDING",
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

  console.log("Created 4 notifications");

  // ─── Feature Flags ─────────────────────────────────────────────────────────
  await Promise.all([
    prisma.featureFlag.create({ data: { key: "dark_mode", enabled: true } }),
    prisma.featureFlag.create({ data: { key: "new_dashboard", enabled: false } }),
    prisma.featureFlag.create({ data: { key: "ai_analysis", enabled: true } }),
    prisma.featureFlag.create({ data: { key: "export_csv", enabled: false } }),
  ]);

  console.log("Created 4 feature flags");

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n─── Pipeline Summary ───");
  console.log("  10 sources (8 processed, 1 raw, 1 ignored)");
  console.log("   → 8 signals (from processed sources)");
  console.log("   → 4 events + 3 alerts (events with isAlert=true)");
  console.log("");
  console.log("Seed complete! Demo credentials:");
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
