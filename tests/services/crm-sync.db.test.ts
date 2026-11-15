/**
 * Who the CRM sync picks (services/crm-sync.ts) against the real schema:
 * pending self-signups go to prospects, approved self-signups to approved,
 * and everyone else (invited staff, service accounts, inactive or demoted
 * users) stays out of the CRM. Self-seeding; run with `bun run test:db`.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { findCrmSyncCandidates } from "../../src/services/crm-sync.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `crm-sync-db-${Date.now()}`;
const email = (key: string) => `${RUN}-${key}@example.org`;

/** key → [role, isActive, approvedAt set] */
const USERS: Record<string, [string, boolean, boolean]> = {
  pending: ["pending", true, false],
  approvedMember: ["member", true, true],
  approvedNowAdmin: ["admin", true, true],
  invitedMember: ["member", true, false],
  approvedThenSuspendedToPending: ["pending", true, true],
  serviceWorker: ["worker", true, true],
  inactivePending: ["pending", false, false],
  inactiveApproved: ["member", false, true],
};

describeIfDb("findCrmSyncCandidates", () => {
  beforeAll(async () => {
    for (const [key, [role, isActive, approved]] of Object.entries(USERS)) {
      await prisma.user.create({
        data: {
          id: `${RUN}-${key}`,
          email: email(key),
          name: `Test ${key}`,
          role,
          isActive,
          approvedAt: approved ? new Date() : null,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  });

  it("picks pending and approved self-signups only, each with its collection", async () => {
    const mine = (await findCrmSyncCandidates(prisma)).filter((c) => c.email.startsWith(RUN));

    expect(mine.map((c) => [c.email, c.target]).sort()).toEqual(
      [
        [email("approvedMember"), "approved"],
        [email("approvedNowAdmin"), "approved"],
        [email("approvedThenSuspendedToPending"), "prospects"],
        [email("pending"), "prospects"],
      ].sort(),
    );
  });

  it("the approved_at migration backfills from the earliest approval log row", async () => {
    const id = `${RUN}-backfill`;
    await prisma.user.create({ data: { id, email: email("backfill"), name: "Backfill", role: "member" } });
    const first = new Date("2026-03-01T10:00:00Z");
    for (const createdAt of [new Date("2026-04-01T10:00:00Z"), first]) {
      await prisma.activityLogs.create({
        data: { userId: id, action: "user.approved", resourceType: "user", resourceId: id, createdAt },
      });
    }
    const sql = readFileSync("prisma/migrations/20261115150000_user_approved_at/migration.sql", "utf8");
    const backfill = sql.slice(sql.indexOf(`UPDATE "user"`));

    try {
      await prisma.$executeRawUnsafe(backfill);
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user.approvedAt).toEqual(first);
    } finally {
      await prisma.activityLogs.deleteMany({ where: { resourceId: id } });
    }
  });
});
