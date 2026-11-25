/**
 * Location challenges the pipeline files (Exponential #1653), against the
 * real schema: the origin column and its default, and who may file.
 *
 * Self-seeding: a country with two states and three districts, three teams
 * (one per scope, and one with no scope), a pipeline user and Signals, all
 * deleted in afterAll, so it runs against an empty scratch database:
 * `bun run test:db tests/resolvers/signalLocationChallengeFromPipeline.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { signalLocationChallengeResolvers } from "../../src/resolvers/signalLocationChallenge.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { fileSignalLocationChallengeFromPipeline, submitSignalLocationChallenge, decideSignalLocationChallenge } =
  signalLocationChallengeResolvers.Mutation;

const RUN = `slc-pipe-${Date.now()}`;
const PIPELINE_ID = `${RUN}-pipeline`;
const PLATFORM_ID = `${RUN}-platform`;
const MEMBER_ID = `${RUN}-member`;
const ORG_ID = `${RUN}-org`;
const STATE_TEAM_ID = `${RUN}-team-state`;
const DISTRICT_TEAM_ID = `${RUN}-team-district`;
const GLOBAL_TEAM_ID = `${RUN}-team-global`;
const COUNTRY_ID = `${RUN}-country`;
const STATE_A_ID = `${RUN}-state-a`;
const STATE_B_ID = `${RUN}-state-b`;
const DISTRICT_A1_ID = `${RUN}-district-a1`;
const DISTRICT_A2_ID = `${RUN}-district-a2`;
const DISTRICT_B1_ID = `${RUN}-district-b1`;
const USER_IDS = [PIPELINE_ID, PLATFORM_ID, MEMBER_ID];

const asUser = (id: string, role: string): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "api_key", locale: "en" }) as unknown as Context;
const pipeline = asUser(PIPELINE_ID, "pipeline");
const platform = asUser(PLATFORM_ID, "admin");
const member = asUser(MEMBER_ID, "member");

/** The point Dataminr sent: inside district B1. */
const DATAMINR_POINT = { proposedLat: 51.5, proposedLng: 53.5 };

let sourceId: string | undefined;

/** A Signal the pipeline placed at `locationId`. */
async function signalAt(locationId: string): Promise<string> {
  const signal = await prisma.signals.create({
    data: {
      sourceId: sourceId!,
      rawData: {},
      contentHash: `${RUN}-${Math.random()}`,
      title: "Explosions reported",
      publishedAt: new Date("2026-11-22T00:00:00.000Z"),
      locationId,
      countries: { connect: [{ id: COUNTRY_ID }] },
    },
  });
  return signal.id;
}

async function area(id: string, name: string, level: number, parentId: string | null, ancestors: string[], wkt: string) {
  await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "parent_id", "ancestor_ids", "geometry")
    VALUES (${id}, ${name}, ${level}, ${parentId}, ${ancestors}::text[], ST_GeomFromText(${wkt}, 4326))`;
}

describeIfDb("Location challenges the pipeline files", () => {
  beforeAll(async () => {
    for (const [id, role] of [[PIPELINE_ID, "pipeline"], [PLATFORM_ID, "admin"], [MEMBER_ID, "member"]]) {
      await prisma.user.create({ data: { id: id!, name: id!, email: `${id}@example.test`, role: role! } });
    }
    // Testland: state A (west, districts A1 and A2) and state B (east,
    // district B1). ancestor_ids run nearest first, as the importer writes.
    await area(COUNTRY_ID, "Testland", 0, null, [], "MULTIPOLYGON(((50 50, 54 50, 54 54, 50 54, 50 50)))");
    await area(STATE_A_ID, "State A", 1, COUNTRY_ID, [COUNTRY_ID], "MULTIPOLYGON(((50 50, 52 50, 52 54, 50 54, 50 50)))");
    await area(STATE_B_ID, "State B", 1, COUNTRY_ID, [COUNTRY_ID], "MULTIPOLYGON(((52 50, 54 50, 54 54, 52 54, 52 50)))");
    await area(DISTRICT_A1_ID, "A1", 2, STATE_A_ID, [STATE_A_ID, COUNTRY_ID], "MULTIPOLYGON(((50 50, 52 50, 52 52, 50 52, 50 50)))");
    await area(DISTRICT_A2_ID, "A2", 2, STATE_A_ID, [STATE_A_ID, COUNTRY_ID], "MULTIPOLYGON(((50 52, 52 52, 52 54, 50 54, 50 52)))");
    await area(DISTRICT_B1_ID, "B1", 2, STATE_B_ID, [STATE_B_ID, COUNTRY_ID], "MULTIPOLYGON(((52 50, 54 50, 54 54, 52 54, 52 50)))");

    await prisma.organisations.create({ data: { id: ORG_ID, name: "SLC Pipe Org", slug: ORG_ID } });
    for (const id of [STATE_TEAM_ID, DISTRICT_TEAM_ID, GLOBAL_TEAM_ID]) {
      await prisma.teams.create({ data: { id, organisationId: ORG_ID, name: id, slug: id } });
    }
    await prisma.teamLocations.createMany({
      data: [
        { teamId: STATE_TEAM_ID, locationId: STATE_A_ID },
        { teamId: DISTRICT_TEAM_ID, locationId: DISTRICT_A1_ID },
      ],
    });
    await prisma.teamMembers.create({ data: { teamId: STATE_TEAM_ID, userId: MEMBER_ID, role: "analyst" } });
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { userId: { in: USER_IDS } } });
    // Challenges cascade with their Signal.
    if (sourceId) await prisma.signals.deleteMany({ where: { sourceId } });
    if (sourceId) await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    await prisma.teamLocations.deleteMany({ where: { teamId: { in: [STATE_TEAM_ID, DISTRICT_TEAM_ID] } } });
    await prisma.teamMembers.deleteMany({ where: { userId: { in: USER_IDS } } });
    await prisma.teams.deleteMany({ where: { organisationId: ORG_ID } });
    await prisma.organisations.deleteMany({ where: { id: ORG_ID } });
    await prisma.locations.deleteMany({ where: { ancestorIds: { has: COUNTRY_ID } } });
    await prisma.locations.deleteMany({ where: { id: COUNTRY_ID } });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  });

  it("files a challenge with origin PIPELINE and the source's point as the proposed point", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    const filed = await fileSignalLocationChallengeFromPipeline(
      null,
      { input: { signalId, ...DATAMINR_POINT, proposedName: " Dataminr point ", note: "Text names another state" } },
      pipeline,
    );
    expect(await prisma.signalLocationChallenges.findUniqueOrThrow({ where: { id: filed.id } })).toMatchObject({
      signalId,
      origin: "PIPELINE",
      status: "consideration",
      createdBy: PIPELINE_ID,
      proposedLat: 51.5,
      proposedLng: 53.5,
      proposedName: "Dataminr point",
      note: "Text names another state",
      previousLocationId: DISTRICT_B1_ID,
    });
    // Filing never moves the Signal.
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).locationId).toBe(DISTRICT_B1_ID);
  });

  it("lets a platform admin file one, and rejects every other caller", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    const input = { signalId, ...DATAMINR_POINT };
    await expect(fileSignalLocationChallengeFromPipeline(null, { input }, member)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(await prisma.signalLocationChallenges.count({ where: { signalId } })).toBe(0);
    const filed = await fileSignalLocationChallengeFromPipeline(null, { input }, platform);
    expect(filed).toMatchObject({ origin: "PIPELINE", createdBy: PLATFORM_ID });
  });

  it("rejects a point outside the areas CLEAR covers, and an unknown Signal", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    await expect(
      fileSignalLocationChallengeFromPipeline(null, { input: { signalId, proposedLat: 10, proposedLng: 10 } }, pipeline),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      fileSignalLocationChallengeFromPipeline(null, { input: { signalId: `${RUN}-nope`, ...DATAMINR_POINT } }, pipeline),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("goes to the team whose area holds the Signal's new place, the most specific first", async () => {
    const teamOf = async (locationId: string) => {
      const signalId = await signalAt(locationId);
      const filed = await fileSignalLocationChallengeFromPipeline(
        null,
        { input: { signalId, ...DATAMINR_POINT } },
        pipeline,
      );
      return filed.teamId;
    };
    // A1 is in the district team's scope and in the state team's.
    expect(await teamOf(DISTRICT_A1_ID)).toBe(DISTRICT_TEAM_ID);
    // A2 is only in the state team's.
    expect(await teamOf(DISTRICT_A2_ID)).toBe(STATE_TEAM_ID);
    // No team's scope holds B1: the team with no scope does not own it.
    expect(await teamOf(DISTRICT_B1_ID)).toBeNull();
  });

  it("a team's admin decides the pipeline challenge filed for their team", async () => {
    await prisma.teamMembers.create({ data: { teamId: DISTRICT_TEAM_ID, userId: MEMBER_ID, role: "team_admin" } });
    const signalId = await signalAt(DISTRICT_A1_ID);
    const filed = await fileSignalLocationChallengeFromPipeline(
      null,
      { input: { signalId, ...DATAMINR_POINT } },
      pipeline,
    );
    const decided = await decideSignalLocationChallenge(null, { id: filed.id, decision: "DECLINE" }, member);
    expect(decided).toMatchObject({ status: "declined", decidedBy: MEMBER_ID, origin: "PIPELINE" });
  });

  it("a point in another state than the team's area is for a platform admin to accept", async () => {
    // The text placed the Signal in A1; Dataminr's point is in state B. The
    // district team's admin may keep the new place (DECLINE) but not write a
    // point outside the team's area: platform admins decide these for now.
    const signalId = await signalAt(DISTRICT_A1_ID);
    const filed = await fileSignalLocationChallengeFromPipeline(
      null,
      { input: { signalId, ...DATAMINR_POINT } },
      pipeline,
    );
    expect(filed.teamId).toBe(DISTRICT_TEAM_ID);
    await expect(
      decideSignalLocationChallenge(null, { id: filed.id, decision: "ACCEPT" }, member),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const accepted = await decideSignalLocationChallenge(null, { id: filed.id, decision: "ACCEPT" }, platform);
    expect(accepted).toMatchObject({ status: "accepted", decidedBy: PLATFORM_ID });
    const signal = await prisma.signals.findUniqueOrThrow({
      where: { id: signalId },
      include: { generalLocation: { select: { ancestorIds: true } } },
    });
    expect(signal.generalLocation?.ancestorIds).toContain(DISTRICT_B1_ID);
  });

  it("returns the open challenge instead of filing a second one", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    const input = { signalId, ...DATAMINR_POINT };
    const first = await fileSignalLocationChallengeFromPipeline(null, { input }, pipeline);
    const again = await fileSignalLocationChallengeFromPipeline(
      null,
      { input: { ...input, proposedLat: 51.6, note: "A later run" } },
      pipeline,
    );
    expect(again.id).toBe(first.id);
    expect(await prisma.signalLocationChallenges.findMany({ where: { signalId } })).toMatchObject([
      { id: first.id, status: "consideration", proposedLat: 51.5, note: null },
    ]);
  });

  it("leaves a person's open challenge as it is and returns it", async () => {
    const signalId = await signalAt(DISTRICT_A2_ID);
    const persons = await submitSignalLocationChallenge(
      null,
      { input: { signalId, teamId: STATE_TEAM_ID, note: "Looks wrong" } },
      member,
    );
    const returned = await fileSignalLocationChallengeFromPipeline(
      null,
      { input: { signalId, ...DATAMINR_POINT } },
      pipeline,
    );
    expect(returned).toMatchObject({ id: persons.id, origin: "PERSON", status: "consideration" });
    expect(await prisma.signalLocationChallenges.count({ where: { signalId } })).toBe(1);
  });

  it("files one challenge when two runs file at the same moment", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    const input = { signalId, ...DATAMINR_POINT };
    const [a, b] = await Promise.all([
      fileSignalLocationChallengeFromPipeline(null, { input }, pipeline),
      fileSignalLocationChallengeFromPipeline(null, { input }, pipeline),
    ]);
    expect(a.id).toBe(b.id);
    expect(await prisma.signalLocationChallenges.count({ where: { signalId } })).toBe(1);
  });

  it("files a new one once the earlier challenge is decided", async () => {
    const signalId = await signalAt(DISTRICT_B1_ID);
    const input = { signalId, ...DATAMINR_POINT };
    const first = await fileSignalLocationChallengeFromPipeline(null, { input }, pipeline);
    await decideSignalLocationChallenge(null, { id: first.id, decision: "DECLINE" }, platform);
    const second = await fileSignalLocationChallengeFromPipeline(null, { input }, pipeline);
    expect(second.id).not.toBe(first.id);
  });

  it("keeps origin PERSON on a challenge a person files", async () => {
    const signalId = await signalAt(DISTRICT_A2_ID);
    const filed = await submitSignalLocationChallenge(
      null,
      { input: { signalId, teamId: STATE_TEAM_ID, note: "Looks wrong" } },
      member,
    );
    expect(filed).toMatchObject({ origin: "PERSON", createdBy: MEMBER_ID });
  });
});
