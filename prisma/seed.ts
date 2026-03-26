import { randomUUID } from "node:crypto";
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { auth } from "../src/lib/auth.js";
import { env } from "../src/utils/env.js";

// ─── Location Seeding (can be run independently) ────────────────────────────

// ─── Sudan Location Data ─────────────────────────────────────────────────────

interface StateData {
  key: string;
  name: string;
  bbox: string; // MULTIPOLYGON WKT
  districts: { key: string; name: string; lng: number; lat: number }[];
}

const SUDAN_STATES: StateData[] = [
  {
    key: "khartoum", name: "Khartoum",
    bbox: "MULTIPOLYGON(((31.7 15.19, 34.38 15.19, 34.38 16.63, 31.7 16.63, 31.7 15.19)))",
    districts: [
      { key: "khartoumCity", name: "Khartoum City", lng: 32.56, lat: 15.59 },
      { key: "omdurman", name: "Omdurman", lng: 32.48, lat: 15.64 },
      { key: "bahri", name: "Bahri (Khartoum North)", lng: 32.55, lat: 15.65 },
      { key: "jabelAwlia", name: "Jabel Awlia", lng: 32.47, lat: 15.22 },
      { key: "sharqAlNeel", name: "Sharq Al Neel", lng: 32.67, lat: 15.68 },
      { key: "umbadda", name: "Umbadda", lng: 32.38, lat: 15.70 },
      { key: "karrari", name: "Karrari", lng: 32.41, lat: 15.72 },
    ],
  },
  {
    key: "northDarfur", name: "North Darfur",
    bbox: "MULTIPOLYGON(((23.0 13.0, 27.5 13.0, 27.5 20.0, 23.0 20.0, 23.0 13.0)))",
    districts: [
      { key: "elFasher", name: "El Fasher", lng: 25.35, lat: 13.63 },
      { key: "kutum", name: "Kutum", lng: 24.67, lat: 14.20 },
      { key: "kebkabiya", name: "Kebkabiya", lng: 24.32, lat: 13.99 },
      { key: "mellit", name: "Mellit", lng: 25.48, lat: 14.78 },
      { key: "umKeddada", name: "Um Keddada", lng: 26.29, lat: 13.60 },
      { key: "tawila", name: "Tawila", lng: 24.85, lat: 13.36 },
      { key: "elLait", name: "El Lait", lng: 25.85, lat: 18.00 },
      { key: "sarafOmra", name: "Saraf Omra", lng: 24.14, lat: 13.11 },
    ],
  },
  {
    key: "southDarfur", name: "South Darfur",
    bbox: "MULTIPOLYGON(((23.5 8.65, 27.5 8.65, 27.5 13.12, 23.5 13.12, 23.5 8.65)))",
    districts: [
      { key: "nyala", name: "Nyala", lng: 24.88, lat: 12.05 },
      { key: "edDaein", name: "Ed Daein", lng: 26.13, lat: 11.46 },
      { key: "kass", name: "Kass", lng: 24.26, lat: 12.50 },
      { key: "buram", name: "Buram", lng: 25.72, lat: 9.96 },
      { key: "tullus", name: "Tullus", lng: 26.65, lat: 10.58 },
      { key: "reheidAlBirdi", name: "Reheid Al Birdi", lng: 25.90, lat: 12.30 },
      { key: "marshing", name: "Marshing", lng: 24.42, lat: 12.98 },
      { key: "adila", name: "Adila", lng: 27.18, lat: 11.52 },
    ],
  },
  {
    key: "westDarfur", name: "West Darfur",
    bbox: "MULTIPOLYGON(((21.8 11.0, 23.5 11.0, 23.5 14.0, 21.8 14.0, 21.8 11.0)))",
    districts: [
      { key: "elGeneina", name: "El Geneina", lng: 22.45, lat: 13.45 },
      { key: "kulbus", name: "Kulbus", lng: 22.22, lat: 13.88 },
      { key: "habila", name: "Habila (West Darfur)", lng: 22.90, lat: 12.90 },
      { key: "beida", name: "Beida", lng: 22.35, lat: 13.00 },
      { key: "sirba", name: "Sirba", lng: 22.62, lat: 13.22 },
      { key: "jabelMoon", name: "Jabel Moon", lng: 22.15, lat: 13.60 },
    ],
  },
  {
    key: "centralDarfur", name: "Central Darfur",
    bbox: "MULTIPOLYGON(((23.0 11.5, 25.5 11.5, 25.5 14.0, 23.0 14.0, 23.0 11.5)))",
    districts: [
      { key: "zalingei", name: "Zalingei", lng: 23.47, lat: 12.91 },
      { key: "nertiti", name: "Nertiti", lng: 24.26, lat: 12.93 },
      { key: "azum", name: "Azum", lng: 23.62, lat: 13.22 },
      { key: "wadiSalih", name: "Wadi Salih", lng: 23.75, lat: 12.15 },
      { key: "mukjar", name: "Mukjar", lng: 23.89, lat: 12.32 },
      { key: "umDukhun", name: "Um Dukhun", lng: 23.40, lat: 11.76 },
    ],
  },
  {
    key: "eastDarfur", name: "East Darfur",
    bbox: "MULTIPOLYGON(((25.5 9.5, 28.0 9.5, 28.0 13.5, 25.5 13.5, 25.5 9.5)))",
    districts: [
      { key: "edDaeinEast", name: "Ed Daein (East Darfur)", lng: 26.13, lat: 11.46 },
      { key: "abuKarinka", name: "Abu Karinka", lng: 26.27, lat: 11.90 },
      { key: "assalaya", name: "Assalaya", lng: 25.69, lat: 11.35 },
      { key: "elFirdous", name: "El Firdous", lng: 26.52, lat: 10.35 },
      { key: "sheiria", name: "Sheiria", lng: 27.15, lat: 11.43 },
      { key: "yassin", name: "Yassin", lng: 25.88, lat: 12.10 },
    ],
  },
  {
    key: "northKordofan", name: "North Kordofan",
    bbox: "MULTIPOLYGON(((27.5 12.0, 32.5 12.0, 32.5 16.0, 27.5 16.0, 27.5 12.0)))",
    districts: [
      { key: "elObeid", name: "El Obeid", lng: 30.22, lat: 13.18 },
      { key: "umRawaba", name: "Um Rawaba", lng: 31.22, lat: 12.90 },
      { key: "enNahud", name: "En Nahud", lng: 28.43, lat: 12.69 },
      { key: "sheikan", name: "Sheikan", lng: 30.30, lat: 13.30 },
      { key: "bara", name: "Bara", lng: 30.37, lat: 13.70 },
      { key: "sodari", name: "Sodari", lng: 30.55, lat: 14.45 },
      { key: "umDam", name: "Um Dam", lng: 31.45, lat: 13.51 },
      { key: "jabrat", name: "Jabrat El Sheikh", lng: 29.33, lat: 12.95 },
    ],
  },
  {
    key: "southKordofan", name: "South Kordofan",
    bbox: "MULTIPOLYGON(((28.5 9.5, 32.0 9.5, 32.0 12.5, 28.5 12.5, 28.5 9.5)))",
    districts: [
      { key: "kadugli", name: "Kadugli", lng: 29.72, lat: 11.01 },
      { key: "dilling", name: "Dilling", lng: 29.66, lat: 12.06 },
      { key: "abuJubaiyha", name: "Abu Jubaiyha", lng: 31.22, lat: 11.60 },
      { key: "rashad", name: "Rashad", lng: 31.05, lat: 11.85 },
      { key: "talodi", name: "Talodi", lng: 30.38, lat: 10.63 },
      { key: "kaduqli", name: "Heiban", lng: 30.12, lat: 11.40 },
      { key: "lagawa", name: "Lagawa", lng: 28.92, lat: 11.35 },
    ],
  },
  {
    key: "westKordofan", name: "West Kordofan",
    bbox: "MULTIPOLYGON(((27.0 10.0, 30.0 10.0, 30.0 13.0, 27.0 13.0, 27.0 10.0)))",
    districts: [
      { key: "elFula", name: "El Fula", lng: 28.35, lat: 11.73 },
      { key: "muglad", name: "Muglad", lng: 27.73, lat: 11.04 },
      { key: "abyei", name: "Abyei", lng: 28.44, lat: 9.59 },
      { key: "babanusa", name: "Babanusa", lng: 27.80, lat: 11.33 },
      { key: "ghubaysh", name: "Ghubaysh", lng: 28.60, lat: 12.30 },
    ],
  },
  {
    key: "blueNile", name: "Blue Nile",
    bbox: "MULTIPOLYGON(((33.0 9.5, 35.5 9.5, 35.5 12.5, 33.0 12.5, 33.0 9.5)))",
    districts: [
      { key: "edDamazin", name: "Ed Damazin", lng: 34.36, lat: 11.79 },
      { key: "roseires", name: "Roseires", lng: 34.38, lat: 11.85 },
      { key: "kurmuk", name: "Kurmuk", lng: 34.28, lat: 10.55 },
      { key: "bau", name: "Bau", lng: 34.07, lat: 10.96 },
      { key: "geissan", name: "Geissan", lng: 34.42, lat: 10.99 },
      { key: "tadamon", name: "Tadamon", lng: 33.85, lat: 11.28 },
    ],
  },
  {
    key: "whiteNile", name: "White Nile",
    bbox: "MULTIPOLYGON(((31.5 12.0, 33.5 12.0, 33.5 14.5, 31.5 14.5, 31.5 12.0)))",
    districts: [
      { key: "rabak", name: "Rabak", lng: 32.74, lat: 13.18 },
      { key: "kosti", name: "Kosti", lng: 32.66, lat: 13.16 },
      { key: "dueim", name: "Ed Dueim", lng: 32.30, lat: 14.00 },
      { key: "tendalti", name: "Tendalti", lng: 32.60, lat: 13.46 },
      { key: "jabalein", name: "Jabalein", lng: 32.95, lat: 12.59 },
      { key: "guli", name: "Guli", lng: 32.25, lat: 12.65 },
    ],
  },
  {
    key: "sennar", name: "Sennar",
    bbox: "MULTIPOLYGON(((32.5 12.0, 35.5 12.0, 35.5 14.0, 32.5 14.0, 32.5 12.0)))",
    districts: [
      { key: "sennarCity", name: "Sennar City", lng: 33.60, lat: 13.55 },
      { key: "singa", name: "Singa", lng: 33.93, lat: 13.15 },
      { key: "dinder", name: "Dinder", lng: 35.00, lat: 12.50 },
      { key: "abuHugar", name: "Abu Hugar", lng: 33.33, lat: 13.09 },
      { key: "easternSennar", name: "Eastern Sennar", lng: 34.30, lat: 13.25 },
      { key: "suruj", name: "Suruj", lng: 33.66, lat: 12.70 },
    ],
  },
  {
    key: "gezira", name: "Gezira",
    bbox: "MULTIPOLYGON(((32.5 13.5, 34.5 13.5, 34.5 15.5, 32.5 15.5, 32.5 13.5)))",
    districts: [
      { key: "wadMedani", name: "Wad Medani", lng: 33.52, lat: 14.40 },
      { key: "managil", name: "Managil", lng: 32.99, lat: 14.25 },
      { key: "hasaheisa", name: "Hasaheisa", lng: 33.30, lat: 14.75 },
      { key: "kamlin", name: "Kamlin", lng: 32.70, lat: 15.30 },
      { key: "elMesallamiya", name: "El Mesallamiya", lng: 33.60, lat: 14.63 },
      { key: "southGezira", name: "South Gezira", lng: 33.18, lat: 13.90 },
      { key: "umAlQura", name: "Um Al Qura", lng: 33.02, lat: 14.55 },
    ],
  },
  {
    key: "kassala", name: "Kassala",
    bbox: "MULTIPOLYGON(((35.0 14.5, 37.0 14.5, 37.0 17.0, 35.0 17.0, 35.0 14.5)))",
    districts: [
      { key: "kassalaCity", name: "Kassala City", lng: 36.40, lat: 15.45 },
      { key: "halfa", name: "New Halfa", lng: 35.60, lat: 15.32 },
      { key: "aroma", name: "Aroma", lng: 36.14, lat: 15.82 },
      { key: "khashm", name: "Khashm El Girba", lng: 35.88, lat: 14.90 },
      { key: "wagerHamid", name: "Wagar", lng: 36.25, lat: 15.56 },
      { key: "telkok", name: "Telkok", lng: 36.50, lat: 15.00 },
    ],
  },
  {
    key: "redSea", name: "Red Sea",
    bbox: "MULTIPOLYGON(((35.5 17.5, 38.6 17.5, 38.6 22.0, 35.5 22.0, 35.5 17.5)))",
    districts: [
      { key: "portSudan", name: "Port Sudan", lng: 37.22, lat: 19.62 },
      { key: "suakin", name: "Suakin", lng: 37.33, lat: 19.11 },
      { key: "tokar", name: "Tokar", lng: 37.73, lat: 18.43 },
      { key: "halayib", name: "Halayib", lng: 36.65, lat: 22.19 },
      { key: "sinkat", name: "Sinkat", lng: 36.72, lat: 19.78 },
      { key: "haya", name: "Haya", lng: 36.38, lat: 18.33 },
    ],
  },
  {
    key: "riverNile", name: "River Nile",
    bbox: "MULTIPOLYGON(((31.5 16.5, 35.0 16.5, 35.0 20.0, 31.5 20.0, 31.5 16.5)))",
    districts: [
      { key: "atbara", name: "Atbara", lng: 33.98, lat: 17.70 },
      { key: "edDamer", name: "Ed Damer", lng: 33.95, lat: 17.59 },
      { key: "shendi", name: "Shendi", lng: 33.43, lat: 16.68 },
      { key: "berber", name: "Berber", lng: 33.98, lat: 18.02 },
      { key: "abuHamed", name: "Abu Hamed", lng: 33.32, lat: 19.53 },
      { key: "meroe", name: "Meroe", lng: 33.75, lat: 16.94 },
    ],
  },
  {
    key: "northern", name: "Northern",
    bbox: "MULTIPOLYGON(((24.0 18.0, 33.0 18.0, 33.0 22.0, 24.0 22.0, 24.0 18.0)))",
    districts: [
      { key: "dongola", name: "Dongola", lng: 30.48, lat: 19.17 },
      { key: "merowe", name: "Merowe", lng: 31.82, lat: 18.49 },
      { key: "wadi", name: "Wadi Halfa", lng: 31.35, lat: 21.80 },
      { key: "delgo", name: "Delgo", lng: 30.45, lat: 20.46 },
      { key: "elGolid", name: "El Golid", lng: 30.12, lat: 18.88 },
      { key: "elDebba", name: "El Debba", lng: 30.95, lat: 18.06 },
    ],
  },
  {
    key: "gedaref", name: "Gedaref",
    bbox: "MULTIPOLYGON(((34.0 12.5, 37.0 12.5, 37.0 15.5, 34.0 15.5, 34.0 12.5)))",
    districts: [
      { key: "gedarefCity", name: "Gedaref City", lng: 35.40, lat: 14.03 },
      { key: "elFashaga", name: "El Fashaga", lng: 36.19, lat: 13.28 },
      { key: "elFao", name: "El Fao", lng: 34.47, lat: 13.97 },
      { key: "galabat", name: "Galabat", lng: 36.14, lat: 12.92 },
      { key: "rahad", name: "Eastern Rahad", lng: 35.10, lat: 13.55 },
      { key: "butana", name: "Butana", lng: 34.60, lat: 14.80 },
      { key: "gureisha", name: "Gureisha", lng: 35.90, lat: 13.85 },
    ],
  },
];

// ─── Seed Locations ──────────────────────────────────────────────────────────

/** Seeded location IDs keyed by their data key (e.g. "khartoum", "elFasher") */
export type LocationMap = Record<string, { id: string }>;

export async function seedLocations(): Promise<LocationMap> {
  console.log("Seeding locations...");

  // Clear existing locations
  await prisma.$executeRaw`DELETE FROM "locations"`;

  // Track ancestor chains for each location
  const locationAncestors = new Map<string, string[]>();
  const result: LocationMap = {};

  async function insertLocation(
    key: string,
    name: string,
    level: number,
    wkt: string,
    parentId: string | null = null,
  ) {
    const id = randomUUID();
    const ancestorIds = parentId
      ? [parentId, ...(locationAncestors.get(parentId) ?? [])]
      : [];
    locationAncestors.set(id, ancestorIds);

    await prisma.$executeRaw`
      INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestorIds}, ST_GeomFromText(${wkt}, 4326))
    `;
    result[key] = { id };
    return { id };
  }

  // Level 0: Country (bounding box covering all of Sudan ~8.5°N to 22°N, 21.8°E to 38.6°E)
  const sudan = await insertLocation("sudan", "Sudan", 0, "MULTIPOLYGON(((21.8 8.5, 38.6 8.5, 38.6 22.0, 21.8 22.0, 21.8 8.5)))");

  // Level 1: States (sequential to ensure parent exists before children reference it)
  for (const state of SUDAN_STATES) {
    const stateResult = await insertLocation(state.key, state.name, 1, state.bbox, sudan.id);

    // Level 2: Districts within each state
    for (const district of state.districts) {
      await insertLocation(
        district.key,
        district.name,
        2,
        `POINT(${district.lng} ${district.lat})`,
        stateResult.id,
      );
    }
  }

  const stateCount = SUDAN_STATES.length;
  const districtCount = SUDAN_STATES.reduce((sum, s) => sum + s.districts.length, 0);
  console.log(`Created ${1 + stateCount + districtCount} locations (1 country, ${stateCount} states, ${districtCount} districts) with geographic data`);

  return result;
}

// ─── Full Seed ───────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding database...\n");

  // ─── Clear existing data (dependency-safe order) ───────────────────────────
  // NOTE: user, account, session, verification, and apiKeys are preserved
  await prisma.commentTags.deleteMany();
  await prisma.userComments.deleteMany();
  await prisma.userFeedbacks.deleteMany();
  await prisma.eventEscaladedByUsers.deleteMany();
  await prisma.userAlerts.deleteMany();
  await prisma.userAlertSubscriptions.deleteMany();
  await prisma.alerts.deleteMany();
  await prisma.notifications.deleteMany();
  await prisma.signalEvents.deleteMany();
  await prisma.events.deleteMany();
  await prisma.signals.deleteMany();
  await prisma.featureFlags.deleteMany();
  await prisma.disasterTypes.deleteMany();
  await prisma.dataSources.deleteMany();
  await prisma.invitations.deleteMany();
  await prisma.organisationUsers.deleteMany();
  await prisma.organisations.deleteMany();
  console.log("Cleared existing data (users, sessions, accounts, and API keys preserved).");

  // ─── Users (find existing or create via Better Auth) ───────────────────────
  async function getOrCreateUser(name: string, email: string, password: string) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return existing;
    const signup = await auth.api.signUpEmail({ body: { name, email, password } });
    return signup.user;
  }

  const admin = await getOrCreateUser("Admin User", env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  // Ensure admin has global admin role and verified email
  await prisma.user.update({
    where: { id: admin.id },
    data: { role: "admin", emailVerified: true },
  });

  const analyst = await getOrCreateUser("Analyst User", "analyst@clear.dev", "password123");
  await prisma.user.update({ where: { id: analyst.id }, data: { emailVerified: true } });

  const viewer = await getOrCreateUser("Viewer User", "viewer@clear.dev", "password123");
  await prisma.user.update({ where: { id: viewer.id }, data: { emailVerified: true } });

  // ─── Organisation ────────────────────────────────────────────────────────
  // Global admin (admin@clear.dev) does NOT need org membership — global role is sufficient.
  // Analyst is added as the org owner for demo purposes.
  const org = await prisma.organisations.create({
    data: { name: "CLEAR Platform", slug: "clear-platform" },
  });

  await prisma.organisationUsers.create({
    data: { userId: analyst.id, organisationId: org.id, role: "owner" },
  });

  console.log(
    `Created 3 users: admin (${admin.id}), analyst (${analyst.id}), viewer (${viewer.id})`,
  );
  console.log("  admin@clear.dev is global admin (no org membership needed)");
  console.log("  analyst@clear.dev is org owner of 'CLEAR Platform'");
  console.log("  viewer@clear.dev has no org membership (invite-only)");

  const loc = await seedLocations();

  // Convenience aliases for signal/event seed data
  const khartoum = loc.khartoum!;
  const northDarfur = loc.northDarfur!;
  const southDarfur = loc.southDarfur!;
  const khartoumCity = loc.khartoumCity!;
  const omdurman = loc.omdurman!;
  const elFasher = loc.elFasher!;
  const kutum = loc.kutum!;
  const nyala = loc.nyala!;

  // ─── Data Sources ──────────────────────────────────────────────────────────
  const [dataminr, acled, gdacs, dtm] = await Promise.all([
    prisma.dataSources.create({
      data: {
        name: "dataminr",
        type: "api",
        isActive: true,
        baseUrl: "https://api.dataminr.com/firstalert/",
        infoUrl: "https://www.dataminr.com/",
      },
    }),
    prisma.dataSources.create({
      data: {
        name: "acled",
        type: "api",
        isActive: true,
        baseUrl: "https://acleddata.com/api/",
        infoUrl: "https://acleddata.com/",
      },
    }),
    prisma.dataSources.create({
      data: {
        name: "gdacs",
        type: "api",
        isActive: true,
        baseUrl: "https://www.gdacs.org/gdacsapi/api/",
        infoUrl: "https://gdacs.org/",
      },
    }),
    prisma.dataSources.create({
      data: {
        name: "dtm",
        type: "api",
        isActive: true,
        baseUrl: "https://dtmapi.iom.int/api/",
        infoUrl: "https://dtm.iom.int/",
      },
    }),
  ]);

  console.log("Created 4 data sources");

  // ─── Signals (directly from data sources, with location links) ─────────────
  const now = new Date();

  const [sig1, sig2, sig3, sig4, sig5, sig6, sig7, sig8] = await Promise.all([
    // Darfur conflict cluster
    prisma.signals.create({
      data: {
        sourceId: acled.id, // ACLED
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
        sourceId: dataminr.id,
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
        sourceId: dataminr.id,
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
        sourceId: gdacs.id,
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
        sourceId: dataminr.id,
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
        sourceId: dataminr.id,
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
        sourceId: gdacs.id,
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
        sourceId: gdacs.id,
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
        text: "Excellent conflict analysis. Well-corroborated signals.",
      },
    }),
    prisma.userFeedbacks.create({
      data: {
        userId: viewer.id,
        eventId: evtDisplacement.id,
        rating: 4,
        text: "Useful displacement data. Would benefit from satellite imagery.",
      },
    }),
    prisma.userFeedbacks.create({
      data: {
        userId: analyst.id,
        signalId: sig1.id,
        rating: 5,
        text: "High confidence ACLED data, well verified.",
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
      eventId: evtDarfurConflict.id,
      isSituation: false,
      validTo: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
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

  // ─── Disaster Types ─────────────────────────────────────────────────────────
  await prisma.disasterTypes.createMany({
    data: [
      { glideNumber: "et", disasterType: "extreme temperature", disasterClass: "" },
      { glideNumber: "cw", disasterType: "cold wave", disasterClass: "" },
      { glideNumber: "ht", disasterType: "heat wave", disasterClass: "" },
      { glideNumber: "ce", disasterType: "complex emergency", disasterClass: "" },
      { glideNumber: "dr", disasterType: "drought", disasterClass: "" },
      { glideNumber: "eq", disasterType: "earthquake", disasterClass: "" },
      { glideNumber: "ep", disasterType: "epidemic", disasterClass: "" },
      { glideNumber: "ec", disasterType: "extratropical cyclone", disasterClass: "" },
      { glideNumber: "fr", disasterType: "fire", disasterClass: "" },
      { glideNumber: "ff", disasterType: "flash flood", disasterClass: "" },
      { glideNumber: "fl", disasterType: "flood", disasterClass: "" },
      { glideNumber: "in", disasterType: "insect infestation", disasterClass: "" },
      { glideNumber: "sl", disasterType: "slide", disasterClass: "" },
      { glideNumber: "ls", disasterType: "land slide", disasterClass: "" },
      { glideNumber: "ms", disasterType: "mud slide", disasterClass: "" },
      { glideNumber: "av", disasterType: "snow avalanche", disasterClass: "" },
      { glideNumber: "st", disasterType: "severe local storm", disasterClass: "" },
      { glideNumber: "ac", disasterType: "technological disaster", disasterClass: "" },
      { glideNumber: "to", disasterType: "tornado", disasterClass: "" },
      { glideNumber: "tc", disasterType: "tropical cyclone", disasterClass: "" },
      { glideNumber: "wv", disasterType: "wave or surge", disasterClass: "" },
      { glideNumber: "ss", disasterType: "storm surge", disasterClass: "" },
      { glideNumber: "ts", disasterType: "tsunami", disasterClass: "" },
      { glideNumber: "vo", disasterType: "volcano", disasterClass: "" },
      { glideNumber: "wf", disasterType: "wild fire", disasterClass: "" },
      { glideNumber: "vw", disasterType: "violent wind", disasterClass: "" },
      { glideNumber: "ot", disasterType: "other", disasterClass: "" },
      { glideNumber: "pv", disasterType: "political violence", disasterClass: "conflict and violence" },
      { glideNumber: "ba", disasterType: "battles", disasterClass: "conflict and violence" },
      { glideNumber: "pr", disasterType: "protests", disasterClass: "conflict and violence" },
      { glideNumber: "ri", disasterType: "riots", disasterClass: "conflict and violence" },
      { glideNumber: "rv", disasterType: "explosions or remote violence", disasterClass: "conflict and violence" },
      { glideNumber: "vc", disasterType: "violence against civilians", disasterClass: "conflict and violence" },
      { glideNumber: "fc", disasterType: "economic crisis", disasterClass: "" },
      { glideNumber: "fa", disasterType: "famine", disasterClass: "" },
    ],
  });

  console.log("Created 35 disaster types");

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

// ─── CLI Entry Point ─────────────────────────────────────────────────────────
// Usage:
//   bun run prisma/seed.ts                 # Full seed (all tables)
//   bun run prisma/seed.ts --locations     # Seed only locations

const args = process.argv.slice(2);

if (args.includes("--locations")) {
  seedLocations()
    .then(() => console.log("Location seed complete."))
    .catch((e) => {
      console.error("Location seed failed:", e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
} else {
  seed()
    .catch((e) => {
      console.error("Seed failed:", e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
