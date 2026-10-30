/**
 * The NRC aggregate export against the real schema: groups under 5 distinct
 * people are hidden and global admins are excluded, server-side.
 *
 * Self-seeding: one organisation with two teams, users, activity and Agent
 * turns, all deleted in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { nrcExportRows } from "../../src/services/activity-insights.js";
import { activityLogResolvers } from "../../src/resolvers/activityLog.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `nrc-export-${Date.now()}`;
const ORG = `${RUN} org`;
const BIG = `${RUN} big`;
const SMALL = `${RUN} small`;
const DUP = `${RUN} dup`;
const FROM = new Date("2026-09-01T00:00:00Z");
const TO = new Date("2026-09-30T23:59:59Z");
const AT = new Date("2026-09-15T12:00:00Z");

const userIds: string[] = [];
let orgId = "";

async function seedUser(i: string, teamId: string, role: string, globalRole = "member") {
  const id = `${RUN}-${i}`;
  userIds.push(id);
  await prisma.user.create({
    data: { id, name: id, email: `${id}@example.test`, role: globalRole },
  });
  await prisma.teamMembers.create({ data: { teamId, userId: id, role } });
  await prisma.activityLogs.create({ data: { userId: id, action: "auth.login", createdAt: AT } });
  await prisma.conversations.create({
    data: {
      id: `${id}-c`,
      userId: id,
      messages: {
        create: [
          { id: `${id}-m1`, role: "user", content: { secret: "never" }, createdAt: AT },
          { id: `${id}-m2`, role: "assistant", content: {}, costUsd: 0.25, createdAt: AT },
        ],
      },
    },
  });
}

describeIfDb("NRC aggregate export against the real schema", () => {
  beforeAll(async () => {
    const org = await prisma.organisations.create({ data: { name: ORG, slug: RUN } });
    orgId = org.id;
    const big = await prisma.teams.create({
      data: { organisationId: orgId, name: BIG, slug: `${RUN}-big` },
    });
    const small = await prisma.teams.create({
      data: { organisationId: orgId, name: SMALL, slug: `${RUN}-small` },
    });
    // Big team: 5 analysts plus 2 global admins in the same group.
    for (let i = 0; i < 5; i++) await seedUser(`big${i}`, big.id, "analyst");
    for (let i = 0; i < 2; i++) await seedUser(`admin${i}`, big.id, "analyst", "admin");
    // Small team: 4 analysts, and 4 admins that must not lift it over 5.
    for (let i = 0; i < 4; i++) await seedUser(`small${i}`, small.id, "analyst");
    for (let i = 0; i < 4; i++) await seedUser(`sadmin${i}`, small.id, "analyst", "admin");
    // Two different teams that share a name: 3 + 2 people must not merge
    // into one five-person row.
    const dupA = await prisma.teams.create({
      data: { organisationId: orgId, name: DUP, slug: `${RUN}-dup-a` },
    });
    const dupB = await prisma.teams.create({
      data: { organisationId: orgId, name: DUP, slug: `${RUN}-dup-b` },
    });
    for (let i = 0; i < 3; i++) await seedUser(`dupa${i}`, dupA.id, "analyst");
    for (let i = 0; i < 2; i++) await seedUser(`dupb${i}`, dupB.id, "analyst");
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (orgId) await prisma.organisations.delete({ where: { id: orgId } });
  });

  it("keeps groups of 5+ people and counts only non-admins", async () => {
    const rows = (await nrcExportRows(prisma, FROM, TO)).filter((r) => r.organisation === ORG);
    expect(rows).toEqual([
      {
        month: "2026-09",
        organisation: ORG,
        team: BIG,
        role: "analyst",
        distinctUsers: 5,
        actions: 5,
        agentTurns: 5,
        agentCostUsd: 1.25,
      },
    ]);
  });

  it("hides the group under 5 people even with admins in it", async () => {
    const csv = await activityLogResolvers.Query.nrcActivityExport(null, { from: FROM, to: TO }, {
      prisma,
      user: { id: "x", role: "admin" },
    } as unknown as Context);
    expect(csv).toContain(BIG);
    expect(csv).not.toContain(SMALL);
    expect(csv).not.toContain(DUP);
    expect(csv).not.toContain("never");
  });
});

describe("nrc export gate", () => {
  it("rejects non-admins", async () => {
    await expect(
      activityLogResolvers.Query.nrcActivityExport(null, {}, {
        prisma: {},
        user: { id: "u", role: "member" },
      } as unknown as Context),
    ).rejects.toThrow();
  });
});
