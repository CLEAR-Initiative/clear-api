/**
 * Who the CRM sync picks (services/crm-sync.ts) against the real schema:
 * pending self-signups go to prospects, approved self-signups to approved,
 * and everyone else (invited staff, service accounts, inactive or demoted
 * users) stays out of the CRM. Self-seeding; run with `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { findCrmSyncCandidates } from "../../src/services/crm-sync.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `crm-sync-db-${Date.now()}`;
const email = (key: string) => `${RUN}-${key}@example.org`;

/** key → [role, isActive, has a `user.approved` log row] */
const USERS: Record<string, [string, boolean, boolean]> = {
  pending: ["pending", true, false],
  approvedMember: ["member", true, true],
  approvedNowAdmin: ["admin", true, true],
  invitedMember: ["member", true, false],
  serviceWorker: ["worker", true, true],
  inactivePending: ["pending", false, false],
  inactiveApproved: ["member", false, true],
};

describeIfDb("findCrmSyncCandidates", () => {
  beforeAll(async () => {
    for (const [key, [role, isActive, approved]] of Object.entries(USERS)) {
      const user = await prisma.user.create({
        data: { id: `${RUN}-${key}`, email: email(key), name: `Test ${key}`, role, isActive },
      });
      if (approved) {
        await prisma.activityLogs.create({
          data: {
            userId: user.id,
            action: "user.approved",
            resourceType: "user",
            resourceId: user.id,
          },
        });
      }
    }
  });

  afterAll(async () => {
    await prisma.activityLogs.deleteMany({ where: { resourceId: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  });

  it("picks pending and approved self-signups only, each with its collection", async () => {
    const mine = (await findCrmSyncCandidates(prisma)).filter((c) => c.email.startsWith(RUN));

    expect(mine.map((c) => [c.email, c.target]).sort()).toEqual(
      [
        [email("approvedMember"), "approved"],
        [email("approvedNowAdmin"), "approved"],
        [email("pending"), "prospects"],
      ].sort(),
    );
  });
});
