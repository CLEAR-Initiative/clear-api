/**
 * Location challenges against the real schema: the migration's one-open-
 * challenge index and status CHECK, the lock and write onto the Signal, the
 * point created under the containing district, and a source revision keeping
 * the corrected location.
 *
 * Self-seeding: a country and district polygon, a team scoped to the district,
 * its analyst and admin, and a Signal in the district, all deleted in
 * afterAll, so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/signalLocationChallenge.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { signalLocationChallengeResolvers } from "../../src/resolvers/signalLocationChallenge.resolver.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { submitSignalLocationChallenge, decideSignalLocationChallenge } =
  signalLocationChallengeResolvers.Mutation;
const { updateSignalContent } = signalResolvers.Mutation;

const RUN = `slc-db-${Date.now()}`;
const ANALYST_ID = `${RUN}-analyst`;
const ADMIN_ID = `${RUN}-team-admin`;
const PLATFORM_ID = `${RUN}-platform`;
const ORG_ID = `${RUN}-org`;
const TEAM_ID = `${RUN}-team`;
const COUNTRY_ID = `${RUN}-country`;
const DISTRICT_ID = `${RUN}-district`;
const SOURCE_POINT_ID = `${RUN}-source-point`;
/** A neighbouring country with no districts loaded, and a point just inside
 *  the first country, 70 m from the border, named like the place chosen in
 *  the neighbour. */
const COUNTRY_B_ID = `${RUN}-country-b`;
const BORDER_POINT_ID = `${RUN}-border-point`;

const asUser = (id: string, role: string): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session", locale: "en" }) as unknown as Context;
const analyst = asUser(ANALYST_ID, "member");
const teamAdmin = asUser(ADMIN_ID, "member");
const platform = asUser(PLATFORM_ID, "admin");

let sourceId: string | undefined;
let signalId: string;

describeIfDb("Location challenges against the real schema", () => {
  beforeAll(async () => {
    for (const [id, role] of [[ANALYST_ID, "member"], [ADMIN_ID, "member"], [PLATFORM_ID, "admin"]]) {
      await prisma.user.create({ data: { id: id!, name: id!, email: `${id}@example.test`, role: role! } });
    }
    await prisma.organisations.create({ data: { id: ORG_ID, name: "SLC DB Org", slug: ORG_ID } });
    await prisma.teams.create({ data: { id: TEAM_ID, organisationId: ORG_ID, name: "SLC DB Team", slug: TEAM_ID } });
    await prisma.teamMembers.createMany({
      data: [
        { teamId: TEAM_ID, userId: ANALYST_ID, role: "analyst" },
        { teamId: TEAM_ID, userId: ADMIN_ID, role: "team_admin" },
      ],
    });
    // A country around a district, both polygons, and the source's point in
    // the district.
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY_ID}, 'Testland', 0, ARRAY[]::text[],
              ST_GeomFromText('MULTIPOLYGON(((50 50, 54 50, 54 54, 50 54, 50 50)))', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${DISTRICT_ID}, 'Testville', 2, ${COUNTRY_ID}, ARRAY[${COUNTRY_ID}]::text[],
              ST_GeomFromText('MULTIPOLYGON(((51 51, 53 51, 53 53, 51 53, 51 51)))', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
      VALUES (${SOURCE_POINT_ID}, 'Source pin', 4, ${DISTRICT_ID}, ARRAY[${DISTRICT_ID}, ${COUNTRY_ID}]::text[],
              ST_GeomFromText('POINT(51.5 51.5)', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
      VALUES (${COUNTRY_B_ID}, 'Otherland', 0, ARRAY[]::text[],
              ST_GeomFromText('MULTIPOLYGON(((54 50, 58 50, 58 54, 54 54, 54 50)))', 4326))`;
    await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "point_type", "geometry")
      VALUES (${BORDER_POINT_ID}, 'Border market', 4, ${COUNTRY_ID}, ARRAY[${COUNTRY_ID}]::text[], 'landmark-geocoded',
              ST_GeomFromText('POINT(53.9995 52)', 4326))`;
    await prisma.teamLocations.create({ data: { teamId: TEAM_ID, locationId: DISTRICT_ID } });

    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
    signalId = (
      await prisma.signals.create({
        data: {
          sourceId,
          rawData: {},
          contentHash: "h1",
          title: "Clashes reported",
          publishedAt: new Date("2026-10-01T00:00:00.000Z"),
          locationId: SOURCE_POINT_ID,
          countries: { connect: [{ id: COUNTRY_ID }] },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { userId: { in: [ANALYST_ID, ADMIN_ID, PLATFORM_ID] } } });
    // Challenges cascade with their Signal.
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    // The district, the source pin and any point a decision created sit
    // under one of the two countries.
    await prisma.locations.deleteMany({
      where: { OR: [{ ancestorIds: { has: COUNTRY_ID } }, { ancestorIds: { has: COUNTRY_B_ID } }] },
    });
    await prisma.locations.deleteMany({ where: { id: { in: [COUNTRY_ID, COUNTRY_B_ID] } } });
    await prisma.teamMembers.deleteMany({ where: { teamId: TEAM_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [ANALYST_ID, ADMIN_ID, PLATFORM_ID] } } });
    await prisma.teams.deleteMany({ where: { id: TEAM_ID } });
    await prisma.organisations.deleteMany({ where: { id: ORG_ID } });
  });

  it("supersedes, then accepting moves the signal to a named point under its district", async () => {
    const first = await submitSignalLocationChallenge(
      null,
      { input: { signalId, teamId: TEAM_ID, proposedLat: 52.1, proposedLng: 52.1, proposedName: "Old guess" } },
      analyst,
    );
    const second = await submitSignalLocationChallenge(
      null,
      { input: { signalId, teamId: TEAM_ID, proposedLat: 52.5, proposedLng: 52.5, proposedName: "Test market" } },
      analyst,
    );
    expect(await prisma.signalLocationChallenges.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: "superseded",
    });

    const decided = await decideSignalLocationChallenge(null, { id: second.id, decision: "ACCEPT" }, teamAdmin);
    expect(decided).toMatchObject({ status: "accepted", decidedBy: ADMIN_ID });

    const signal = await prisma.signals.findUniqueOrThrow({
      where: { id: signalId },
      include: { generalLocation: true, countries: { select: { id: true } } },
    });
    expect(signal.locationId).toBe(decided!.appliedLocationId);
    expect(signal).toMatchObject({ originId: null, destinationId: null });
    expect(signal.locationCorrectedAt).toBeInstanceOf(Date);
    expect(signal.pipelineLocationId).toBe(SOURCE_POINT_ID);
    expect(signal.countries).toEqual([{ id: COUNTRY_ID }]);
    expect(signal.generalLocation).toMatchObject({
      name: "Test market",
      level: 4,
      parentId: DISTRICT_ID,
      pointType: "landmark-geocoded",
    });
    expect(signal.generalLocation!.ancestorIds).toEqual([DISTRICT_ID, COUNTRY_ID]);
  });

  it("keeps decided challenges as history: a second decline on the signal is no unique clash", async () => {
    for (const note of ["Still wrong", "Wrong again"]) {
      const filed = await submitSignalLocationChallenge(null, { input: { signalId, teamId: TEAM_ID, note } }, analyst);
      await decideSignalLocationChallenge(null, { id: filed.id, decision: "DECLINE" }, teamAdmin);
    }
    const declined = await prisma.signalLocationChallenges.count({ where: { signalId, status: "declined" } });
    expect(declined).toBe(2);
  });

  it("allows only one open challenge per signal in the database", async () => {
    const open = { signalId, teamId: TEAM_ID, createdBy: ANALYST_ID, status: "consideration" };
    await prisma.signalLocationChallenges.create({ data: open });
    await expect(prisma.signalLocationChallenges.create({ data: open })).rejects.toMatchObject({ code: "P2002" });
    await prisma.signalLocationChallenges.updateMany({
      where: { signalId, status: "consideration" },
      data: { status: "superseded" },
    });
  });

  it("rejects a status outside the known set", async () => {
    await expect(
      prisma.signalLocationChallenges.create({
        data: { signalId, teamId: TEAM_ID, createdBy: ANALYST_ID, status: "open" },
      }),
    ).rejects.toThrow(/signal_location_challenges_status_check/);
  });

  it("a source revision updates the content and keeps the corrected location", async () => {
    const before = await prisma.signals.findUniqueOrThrow({ where: { id: signalId } });
    await updateSignalContent(
      null,
      {
        input: {
          id: signalId,
          contentHash: "h2",
          rawData: {},
          title: "Clashes reported (revised)",
          locationId: SOURCE_POINT_ID,
          countryIds: [COUNTRY_ID],
        },
      } as never,
      platform,
    );
    const after = await prisma.signals.findUniqueOrThrow({ where: { id: signalId } });
    expect(after).toMatchObject({
      title: "Clashes reported (revised)",
      contentHash: "h2",
      locationId: before.locationId,
      revision: before.revision + 1,
    });
    expect(after.locationId).not.toBe(SOURCE_POINT_ID);
  });

  it("a point placed where no district is loaded never reuses a same-name point across the border", async () => {
    const filed = await submitSignalLocationChallenge(null, { input: { signalId, teamId: TEAM_ID } }, analyst);
    // A platform admin may place beyond the team's area: just over the border.
    await decideSignalLocationChallenge(
      null,
      { id: filed.id, decision: "CORRECT", point: { lat: 52, lng: 54.0005, name: "Border market" } },
      platform,
    );
    const signal = await prisma.signals.findUniqueOrThrow({
      where: { id: signalId },
      include: { generalLocation: true, countries: { select: { id: true } } },
    });
    expect(signal.locationId).not.toBe(BORDER_POINT_ID);
    expect(signal.generalLocation).toMatchObject({ name: "Border market", parentId: COUNTRY_B_ID });
    expect(signal.countries).toEqual([{ id: COUNTRY_B_ID }]);
  });
});
