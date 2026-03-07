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

  // ─── Locations (3-level hierarchy) ─────────────────────────────────────────
  const us = await prisma.location.create({
    data: { geoId: "US", name: "United States", level: 0 },
  });

  const [california, texas, newYork] = await Promise.all([
    prisma.location.create({
      data: { geoId: "US-CA", name: "California", level: 1, parentId: us.id },
    }),
    prisma.location.create({
      data: { geoId: "US-TX", name: "Texas", level: 1, parentId: us.id },
    }),
    prisma.location.create({
      data: { geoId: "US-NY", name: "New York", level: 1, parentId: us.id },
    }),
  ]);

  const [losAngeles, sanFrancisco, houston, nyc] = await Promise.all([
    prisma.location.create({
      data: { geoId: "US-CA-LA", name: "Los Angeles", level: 2, parentId: california.id },
    }),
    prisma.location.create({
      data: { geoId: "US-CA-SF", name: "San Francisco", level: 2, parentId: california.id },
    }),
    prisma.location.create({
      data: { geoId: "US-TX-HOU", name: "Houston", level: 2, parentId: texas.id },
    }),
    prisma.location.create({
      data: { geoId: "US-NY-NYC", name: "New York City", level: 2, parentId: newYork.id },
    }),
  ]);

  console.log("Created 8 locations (1 country, 3 states, 4 cities)");

  // ─── Data Sources ──────────────────────────────────────────────────────────
  const [twitter, newsApi, govRss] = await Promise.all([
    prisma.dataSource.create({
      data: {
        name: "Twitter/X",
        type: "social_media",
        isActive: true,
        baseUrl: "https://api.twitter.com/2",
        infoUrl: "https://developer.twitter.com",
      },
    }),
    prisma.dataSource.create({
      data: {
        name: "NewsAPI",
        type: "news_aggregator",
        isActive: true,
        baseUrl: "https://newsapi.org/v2",
        infoUrl: "https://newsapi.org",
      },
    }),
    prisma.dataSource.create({
      data: {
        name: "Government RSS",
        type: "rss_feed",
        isActive: false,
        baseUrl: "https://www.govinfo.gov/rss",
        infoUrl: "https://www.govinfo.gov",
      },
    }),
  ]);

  console.log("Created 3 data sources");

  // ─── Detections ────────────────────────────────────────────────────────────
  const [det1, det2, det3, det4, det5, det6] = await Promise.all([
    prisma.detection.create({
      data: {
        title: "Unusual seismic activity reported near LA",
        confidence: 0.87,
        status: "processed",
        sourceId: twitter.id,
        rawData: { tweets: 142, sentiment: "negative", hashtags: ["#earthquake", "#LA"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Wildfire smoke detected in satellite imagery",
        confidence: 0.95,
        status: "processed",
        sourceId: twitter.id,
        rawData: { tweets: 89, sentiment: "alarmed", hashtags: ["#wildfire", "#CalFire"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Flash flood warnings issued for Houston area",
        confidence: 0.92,
        status: "processed",
        sourceId: newsApi.id,
        rawData: { articles: 23, sources: ["AP", "Reuters", "local news"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Minor tremor registered in upstate New York",
        confidence: 0.45,
        status: "raw",
        sourceId: newsApi.id,
        rawData: { articles: 3, sources: ["local news"] },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Coastal erosion report from NOAA",
        confidence: 0.78,
        status: "processed",
        sourceId: govRss.id,
        rawData: { report_id: "NOAA-2026-0312", agency: "NOAA" },
      },
    }),
    prisma.detection.create({
      data: {
        title: "Duplicate weather station reading",
        confidence: 0.3,
        status: "ignored",
        sourceId: govRss.id,
        rawData: { station: "WX-4421", note: "sensor malfunction confirmed" },
      },
    }),
  ]);

  // Link detections to locations
  await Promise.all([
    prisma.detectionLocation.create({ data: { detectionId: det1.id, locationId: losAngeles.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det1.id, locationId: california.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det2.id, locationId: sanFrancisco.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det2.id, locationId: california.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det3.id, locationId: houston.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det3.id, locationId: texas.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det4.id, locationId: newYork.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det5.id, locationId: nyc.id } }),
    prisma.detectionLocation.create({ data: { detectionId: det5.id, locationId: newYork.id } }),
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
        title: "Earthquake Risk Alert - Los Angeles",
        description:
          "Multiple social media reports and seismic data indicate increased earthquake risk in the greater Los Angeles area. Residents should review emergency preparedness plans.",
        severity: 4,
        status: "published",
        sourceId: twitter.id,
        createdById: admin.id,
        primaryEventId: evt1.id,
        events: { connect: [{ id: evt1.id }] },
        metadata: { category: "seismic", affectedPopulation: "10M+" },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Wildfire Smoke Advisory - Northern California",
        description:
          "Satellite imagery confirms active wildfire producing significant smoke. Air quality index may exceed safe levels in the Bay Area over the next 48 hours.",
        severity: 3,
        status: "published",
        sourceId: twitter.id,
        createdById: analyst.id,
        primaryEventId: evt2.id,
        events: { connect: [{ id: evt2.id }] },
        metadata: { category: "wildfire", aqi: "unhealthy" },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Flash Flood Warning - Houston Metro",
        description:
          "National Weather Service has issued flash flood warnings for the Houston metropolitan area. Multiple news sources confirm rising water levels.",
        severity: 5,
        status: "draft",
        sourceId: newsApi.id,
        createdById: admin.id,
        primaryEventId: evt3.id,
        events: { connect: [{ id: evt3.id }] },
        metadata: { category: "flood", nwsWarningId: "TX-2026-0845" },
      },
    }),
    prisma.alert.create({
      data: {
        title: "Coastal Erosion Update - NYC Waterfront",
        description:
          "NOAA report indicates accelerated coastal erosion along NYC waterfront areas. Infrastructure assessments recommended.",
        severity: 2,
        status: "archived",
        sourceId: govRss.id,
        createdById: analyst.id,
        primaryEventId: evt4.id,
        events: { connect: [{ id: evt4.id }] },
        metadata: { category: "erosion", reportRef: "NOAA-2026-0312" },
      },
    }),
  ]);

  // Link alerts to locations
  await Promise.all([
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: losAngeles.id } }),
    prisma.alertLocation.create({ data: { alertId: alert1.id, locationId: california.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: sanFrancisco.id } }),
    prisma.alertLocation.create({ data: { alertId: alert2.id, locationId: california.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: houston.id } }),
    prisma.alertLocation.create({ data: { alertId: alert3.id, locationId: texas.id } }),
    prisma.alertLocation.create({ data: { alertId: alert4.id, locationId: nyc.id } }),
    prisma.alertLocation.create({ data: { alertId: alert4.id, locationId: newYork.id } }),
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
        comment: "High confidence alert. Seismic data corroborates social media signals.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id,
        alertId: alert1.id,
        readAt: new Date(),
        rating: 4,
        comment: "Useful alert, shared with our local emergency team.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id,
        alertId: alert2.id,
        readAt: new Date(),
        rating: 4,
        comment: "Good catch from satellite data. AQI prediction was accurate.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: viewer.id,
        alertId: alert2.id,
        readAt: new Date(),
        rating: 3,
        comment: "Alert was helpful but arrived a bit late.",
      },
    }),
    prisma.userAlert.create({
      data: {
        userId: analyst.id,
        alertId: alert4.id,
        readAt: new Date(),
        rating: 3,
        comment: "Informational but low urgency. Good to have in the archive.",
      },
    }),
  ]);

  console.log("Created 5 user feedback entries");

  // ─── Notifications ────────────────────────────────────────────────────────
  await Promise.all([
    prisma.notifications.create({
      data: {
        userId: analyst.id,
        message: "New earthquake alert published for Los Angeles area",
        notificationType: "alert",
        actionUrl: `/alerts/${alert1.id}`,
        actionText: "View Alert",
        status: "READ",
      },
    }),
    prisma.notifications.create({
      data: {
        userId: viewer.id,
        message: "Flash flood warning drafted for Houston Metro",
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
