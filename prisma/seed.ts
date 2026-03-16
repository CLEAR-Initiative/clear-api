import { randomUUID } from "node:crypto";
import "dotenv/config";
import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/prisma.js";
import { auth } from "../src/lib/auth.js";

async function seed() {
  console.log("Seeding database...\n");

  // ─── Clear existing data (dependency-safe order) ───────────────────────────
  await prisma.commentTags.deleteMany();
  await prisma.userComments.deleteMany();
  await prisma.userFeedbacks.deleteMany();
  await prisma.eventEscaladedByUsers.deleteMany();
  await prisma.userAlerts.deleteMany();
  await prisma.userAlertSubscriptions.deleteMany();
  await prisma.alerts.deleteMany();
  await prisma.notifications.deleteMany();
  await prisma.apiKeys.deleteMany();
  await prisma.signalEvents.deleteMany();
  await prisma.events.deleteMany();
  await prisma.signals.deleteMany();
  await prisma.featureFlags.deleteMany();
  await prisma.dataSources.deleteMany();
  await prisma.$executeRaw`DELETE FROM "locations"`;
  await prisma.organisationUsers.deleteMany();
  await prisma.organisations.deleteMany();
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
  const org = await prisma.organisations.create({
    data: { name: "CLEAR Platform" },
  });

  await Promise.all([
    prisma.organisationUsers.create({
      data: { userId: admin.id, organisationId: org.id, role: "admin" },
    }),
    prisma.organisationUsers.create({
      data: { userId: analyst.id, organisationId: org.id, role: "analyst" },
    }),
    prisma.organisationUsers.create({
      data: { userId: viewer.id, organisationId: org.id, role: "viewer" },
    }),
  ]);

  console.log(
    `Created 3 users: admin (${admin.id}), analyst (${analyst.id}), viewer (${viewer.id})`,
  );

  // ─── Locations (Sudan hierarchy: Country → State → Locality) ─────────────
  async function insertLocation(
    id: string,
    name: string,
    level: number,
    wkt: string,
    parentId: string | null = null,
  ) {
    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "geometry")
      VALUES (${id}, ${name}, ${level}, ${parentId}, ST_GeomFromText(${wkt}, 4326))
    `;
    return { id };
  }

  // Level 0: Country
  const sudanId = randomUUID();
  const sudan = await insertLocation(sudanId, "Sudan", 0, "POINT(30.0 15.5)");

  // Level 1: States
  const khartoumId = randomUUID();
  const northDarfurId = randomUUID();
  const southDarfurId = randomUUID();
  const northKordofanId = randomUUID();

  const [khartoum, northDarfur, southDarfur, _northKordofan] = await Promise.all([
    insertLocation(
      khartoumId,
      "Khartoum",
      1,
      "MULTIPOLYGON(((31.7 15.19, 34.38 15.19, 34.38 16.63, 31.7 16.63, 31.7 15.19)))",
      sudan.id,
    ),
    insertLocation(
      northDarfurId,
      "North Darfur",
      1,
      "MULTIPOLYGON(((23.0 13.0, 27.5 13.0, 27.5 20.0, 23.0 20.0, 23.0 13.0)))",
      sudan.id,
    ),
    insertLocation(
      southDarfurId,
      "South Darfur",
      1,
      "MULTIPOLYGON(((23.5 8.65, 27.5 8.65, 27.5 13.12, 23.5 13.12, 23.5 8.65)))",
      sudan.id,
    ),
    insertLocation(
      northKordofanId,
      "North Kordofan",
      1,
      "MULTIPOLYGON(((27.5 12.0, 32.5 12.0, 32.5 16.0, 27.5 16.0, 27.5 12.0)))",
      sudan.id,
    ),
  ]);

  // Level 2: Localities
  const khartoumCityId = randomUUID();
  const omdurmanId = randomUUID();
  const elFasherId = randomUUID();
  const kutumId = randomUUID();
  const nyalaId = randomUUID();
  const elDaeinId = randomUUID();

  const [khartoumCity, omdurman, elFasher, kutum, nyala, elDaein] = await Promise.all([
    insertLocation(khartoumCityId, "Khartoum City", 2, "POINT(32.56 15.59)", khartoum.id),
    insertLocation(omdurmanId, "Omdurman", 2, "POINT(32.48 15.64)", khartoum.id),
    insertLocation(elFasherId, "El Fasher", 2, "POINT(25.35 13.63)", northDarfur.id),
    insertLocation(kutumId, "Kutum", 2, "POINT(24.67 14.20)", northDarfur.id),
    insertLocation(nyalaId, "Nyala", 2, "POINT(24.88 12.05)", southDarfur.id),
    insertLocation(elDaeinId, "Ed Daein", 2, "POINT(26.13 11.46)", southDarfur.id),
  ]);

  console.log("Created 11 locations (1 country, 4 states, 6 localities) with geographic data");

  // ─── Data Sources ──────────────────────────────────────────────────────────
  const [socialMedia, acled, fewsNet] = await Promise.all([
    prisma.dataSources.create({
      data: {
        name: "Social Media Monitor",
        type: "social_media",
        isActive: true,
        baseUrl: "https://api.social-monitor.org/v2",
        infoUrl: "https://social-monitor.org",
      },
    }),
    prisma.dataSources.create({
      data: {
        name: "ACLED Conflict Data",
        type: "conflict_tracker",
        isActive: true,
        baseUrl: "https://acleddata.com/api/v3",
        infoUrl: "https://acleddata.com",
      },
    }),
    prisma.dataSources.create({
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

  // ─── Signals (directly from data sources, with location links) ─────────────
  const now = new Date();

  const [sig1, sig2, sig3, sig4, sig5, sig6, sig7, sig8] = await Promise.all([
    // Darfur conflict cluster
    prisma.signals.create({
      data: {
        sourceId: acled.id,
        rawData: { events: 12, fatalities: "unknown", source: "ACLED" },
        publishedAt: now,
        collectedAt: now,
        title: "Armed clashes reported near El Fasher",
        description: "ACLED data shows 12 conflict events in the El Fasher area",
        originId: elFasher.id,
        locationId: northDarfur.id,
      },
    }),
    prisma.signals.create({
      data: {
        sourceId: socialMedia.id,
        rawData: { posts: 156, sentiment: "fear", hashtags: ["#RSF", "#Darfur"] },
        publishedAt: now,
        collectedAt: now,
        title: "RSF troop movements detected in North Darfur",
        description: "Social media reports of RSF troop movements across North Darfur",
        locationId: northDarfur.id,
      },
    }),
    // Displacement cluster
    prisma.signals.create({
      data: {
        sourceId: socialMedia.id,
        rawData: { posts: 234, sentiment: "distress", hashtags: ["#Darfur", "#displacement"] },
        publishedAt: now,
        collectedAt: now,
        title: "Displacement surge detected in South Darfur",
        description: "Social media reports of mass displacement in South Darfur",
        originId: northDarfur.id,
        destinationId: nyala.id,
        locationId: southDarfur.id,
      },
    }),
    prisma.signals.create({
      data: {
        sourceId: fewsNet.id,
        rawData: { camp: "Kalma", capacity_pct: 187, report_id: "OCHA-2026-SD-019" },
        publishedAt: now,
        collectedAt: now,
        title: "IDP camp overcrowding reported in Nyala",
        description: "Kalma camp at 187% capacity",
        locationId: nyala.id,
      },
    }),
    // Khartoum flood cluster
    prisma.signals.create({
      data: {
        sourceId: socialMedia.id,
        rawData: { posts: 187, sentiment: "alarmed", hashtags: ["#KhartoumFloods", "#Nile"] },
        publishedAt: now,
        collectedAt: now,
        title: "Flood warnings along the Nile in Khartoum",
        description: "Rising Nile water levels threatening Khartoum",
        locationId: khartoumCity.id,
      },
    }),
    prisma.signals.create({
      data: {
        sourceId: socialMedia.id,
        rawData: { posts: 98, images: 12, location: "White Nile Bridge" },
        publishedAt: now,
        collectedAt: now,
        title: "Bridge damage reported in Omdurman",
        description: "White Nile Bridge structural damage reported",
        locationId: omdurman.id,
      },
    }),
    // Food security cluster
    prisma.signals.create({
      data: {
        sourceId: fewsNet.id,
        rawData: { ipc_phase: 4, report_id: "FEWSNET-2026-03", population_affected: "120K" },
        publishedAt: now,
        collectedAt: now,
        title: "Food insecurity escalation in Kutum locality",
        description: "IPC Phase 4 (Emergency) in Kutum locality",
        locationId: kutum.id,
      },
    }),
    prisma.signals.create({
      data: {
        sourceId: fewsNet.id,
        rawData: { sorghum_pct_increase: 112, millet_pct_increase: 95, period: "Q1 2026" },
        publishedAt: now,
        collectedAt: now,
        title: "Staple food price spikes across North Darfur markets",
        description: "Sorghum prices up 112%, millet up 95%",
        locationId: northDarfur.id,
      },
    }),
  ]);

  console.log("Created 8 signals with location links");

  // ─── Events (group related signals) ───────────────────────────────────────
  const evtDarfurConflict = await prisma.events.create({
    data: {
      title: "North Darfur Conflict Escalation",
      description: "Armed clashes and RSF troop movements detected across North Darfur",
      validFrom: now,
      validTo: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      types: ["conflict"],
      rank: 0.91,
      originId: elFasher.id,
      locationId: northDarfur.id,
    },
  });

  const evtDisplacement = await prisma.events.create({
    data: {
      title: "South Darfur Displacement Crisis",
      description: "Displacement surge in South Darfur with IDP camp overcrowding",
      validFrom: now,
      validTo: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      types: ["displacement"],
      rank: 0.85,
      originId: northDarfur.id,
      destinationId: nyala.id,
      locationId: southDarfur.id,
      populationAffected: BigInt(50000),
    },
  });

  const evtKhartoumFlood = await prisma.events.create({
    data: {
      title: "Khartoum Flood Emergency",
      description: "Nile flooding threatening Khartoum and Omdurman with bridge damage reported",
      validFrom: now,
      validTo: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      types: ["natural_disaster", "flood"],
      rank: 0.87,
      locationId: khartoum.id,
    },
  });

  const evtFoodCrisis = await prisma.events.create({
    data: {
      title: "North Darfur Food Security Emergency",
      description: "Food insecurity escalation with price spikes across North Darfur",
      validFrom: now,
      validTo: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      firstSignalCreatedAt: now,
      lastSignalCreatedAt: now,
      types: ["food_security"],
      rank: 0.82,
      locationId: northDarfur.id,
      populationAffected: BigInt(120000),
    },
  });

  // Link signals to events via signalEvents join table
  await prisma.signalEvents.createMany({
    data: [
      { signalId: sig1.id, eventId: evtDarfurConflict.id, collectedAt: now },
      { signalId: sig2.id, eventId: evtDarfurConflict.id, collectedAt: now },
      { signalId: sig3.id, eventId: evtDisplacement.id, collectedAt: now },
      { signalId: sig4.id, eventId: evtDisplacement.id, collectedAt: now },
      { signalId: sig5.id, eventId: evtKhartoumFlood.id, collectedAt: now },
      { signalId: sig6.id, eventId: evtKhartoumFlood.id, collectedAt: now },
      { signalId: sig7.id, eventId: evtFoodCrisis.id, collectedAt: now },
      { signalId: sig8.id, eventId: evtFoodCrisis.id, collectedAt: now },
    ],
  });

  console.log("Created 4 events (each grouping 2 related signals)");

  // ─── Alerts (separate model referencing events) ────────────────────────────
  const alert1 = await prisma.alerts.create({
    data: { eventId: evtDarfurConflict.id, status: "published" },
  });

  const alert2 = await prisma.alerts.create({
    data: { eventId: evtKhartoumFlood.id, status: "published" },
  });

  const alert3 = await prisma.alerts.create({
    data: { eventId: evtFoodCrisis.id, status: "draft" },
  });

  console.log("Created 3 alerts referencing events");

  // ─── User Alert Subscriptions ──────────────────────────────────────────────
  await Promise.all([
    prisma.userAlertSubscriptions.create({
      data: {
        userId: analyst.id,
        locationId: northDarfur.id,
        alertType: "conflict",
        channel: "email",
        frequency: "immediately",
      },
    }),
    prisma.userAlertSubscriptions.create({
      data: {
        userId: viewer.id,
        locationId: khartoum.id,
        alertType: "natural_disaster",
        channel: "email",
        frequency: "daily",
      },
    }),
  ]);

  console.log("Created 2 alert subscriptions");

  // ─── User Alerts (alerts delivered to users) ───────────────────────────────
  await Promise.all([
    prisma.userAlerts.create({
      data: { userId: analyst.id, alertId: alert1.id, viewedAt: new Date() },
    }),
    prisma.userAlerts.create({
      data: { userId: viewer.id, alertId: alert1.id, viewedAt: new Date() },
    }),
    prisma.userAlerts.create({
      data: { userId: analyst.id, alertId: alert2.id, viewedAt: new Date() },
    }),
    prisma.userAlerts.create({
      data: { userId: viewer.id, alertId: alert2.id, viewedAt: new Date() },
    }),
    prisma.userAlerts.create({
      data: { userId: analyst.id, alertId: alert3.id },
    }),
  ]);

  console.log("Created 5 user alert entries");

  // ─── User Feedbacks ────────────────────────────────────────────────────────
  await Promise.all([
    prisma.userFeedbacks.create({
      data: {
        userId: analyst.id,
        eventId: evtDarfurConflict.id,
        rating: 5,
        feedback: "Excellent conflict analysis. Well-corroborated signals.",
      },
    }),
    prisma.userFeedbacks.create({
      data: {
        userId: viewer.id,
        eventId: evtDisplacement.id,
        rating: 4,
        feedback: "Useful displacement data. Would benefit from satellite imagery.",
      },
    }),
    prisma.userFeedbacks.create({
      data: {
        userId: analyst.id,
        signalId: sig1.id,
        rating: 5,
        feedback: "High confidence ACLED data, well verified.",
      },
    }),
  ]);

  console.log("Created 3 user feedbacks");

  // ─── User Comments ─────────────────────────────────────────────────────────
  const comment1 = await prisma.userComments.create({
    data: {
      userId: analyst.id,
      eventId: evtDarfurConflict.id,
      comment: "The conflict-displacement causal link is well supported by the underlying signals.",
      isCommentReply: false,
    },
  });

  await prisma.userComments.create({
    data: {
      userId: viewer.id,
      eventId: evtDarfurConflict.id,
      comment: "Shared with our humanitarian coordination team in Darfur.",
      isCommentReply: true,
      repliedToCommentId: comment1.id,
    },
  });

  // Tag admin in the reply
  await prisma.commentTags.create({
    data: { userId: admin.id, commentId: comment1.id },
  });

  console.log("Created 2 user comments with 1 tag");

  // ─── Event Escalations ─────────────────────────────────────────────────────
  await prisma.eventEscaladedByUsers.create({
    data: {
      userId: analyst.id,
      alertId: alert1.id,
      isSituation: false,
    },
  });

  console.log("Created 1 event escalation");

  // ─── Notifications ────────────────────────────────────────────────────────
  await Promise.all([
    prisma.notifications.create({
      data: {
        userId: analyst.id,
        message: "New alert published: North Darfur Conflict Escalation",
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
        message: "Draft alert ready for review: North Darfur Food Security Emergency",
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
    prisma.featureFlags.create({ data: { key: "dark_mode", enabled: true } }),
    prisma.featureFlags.create({ data: { key: "new_dashboard", enabled: false } }),
    prisma.featureFlags.create({ data: { key: "ai_analysis", enabled: true } }),
    prisma.featureFlags.create({ data: { key: "export_csv", enabled: false } }),
  ]);

  console.log("Created 4 feature flags");

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n─── Pipeline Summary ───");
  console.log("  8 signals (from 3 data sources, with location links)");
  console.log("  4 events (grouping related signals)");
  console.log("  3 alerts (referencing events)");
  console.log("  5 user alerts, 3 feedbacks, 2 comments, 1 escalation");
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
