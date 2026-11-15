/**
 * The CRM sync run (services/crm-sync.ts): dry runs and an unconfigured CRM
 * make no CRM calls, one user's failure doesn't stop the run, and the
 * summary separates changed, unchanged and failed users so a repeat run
 * reads as a no-op. Candidate selection against real SQL is in
 * crm-sync.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configuredMock, pushToProspectsMock, syncApprovedContactMock } = vi.hoisted(() => ({
  configuredMock: vi.fn(),
  pushToProspectsMock: vi.fn(),
  syncApprovedContactMock: vi.fn(),
}));

vi.mock("../../src/services/exponential.js", () => ({
  isCrmMirrorConfigured: configuredMock,
  pushToProspects: pushToProspectsMock,
  syncApprovedContact: syncApprovedContactMock,
}));

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  findCrmSyncCandidates,
  formatCrmSyncSummary,
  runScheduledCrmSync,
  startCrmSyncWorker,
  stopCrmSyncWorker,
  syncCrm,
  type CrmSyncSummary,
} from "../../src/services/crm-sync.js";

const USERS = [
  { id: "u1", email: "pending@example.org", name: "Ada Lovelace", role: "pending" },
  { id: "u2", email: "member@example.org", name: "Grace Hopper", role: "member" },
  { id: "u3", email: "admin@example.org", name: "Alan", role: "admin" },
];

function fakePrisma(users = USERS) {
  const activityFindMany = vi.fn(async () => [{ resourceId: "u2" }, { resourceId: "u3" }]);
  const userFindMany = vi.fn(async () => users);
  const prisma = {
    activityLogs: { findMany: activityFindMany },
    user: { findMany: userFindMany },
  } as unknown as PrismaClient;
  return { prisma, activityFindMany, userFindMany };
}

beforeEach(() => {
  configuredMock.mockReset().mockReturnValue(true);
  pushToProspectsMock.mockReset().mockResolvedValue({ ok: true, value: { contactId: "c", changed: true } });
  syncApprovedContactMock
    .mockReset()
    .mockResolvedValue({ ok: true, value: { contactId: "c", warnings: [], changed: true } });
});

describe("findCrmSyncCandidates", () => {
  it("asks for active pending users plus approved users still member or admin", async () => {
    const { prisma, activityFindMany, userFindMany } = fakePrisma();

    const candidates = await findCrmSyncCandidates(prisma);

    expect(activityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "user.approved", resourceType: "user", resourceId: { not: null } },
      }),
    );
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          OR: [{ role: "pending" }, { id: { in: ["u2", "u3"] }, role: { in: ["member", "admin"] } }],
        },
      }),
    );
    expect(candidates.map((c) => [c.email, c.target])).toEqual([
      ["pending@example.org", "prospects"],
      ["member@example.org", "approved"],
      ["admin@example.org", "approved"],
    ]);
  });
});

describe("syncCrm", () => {
  it("makes no CRM calls on a dry run", async () => {
    const summary = await syncCrm(fakePrisma().prisma, { dryRun: true });

    expect(pushToProspectsMock).not.toHaveBeenCalled();
    expect(syncApprovedContactMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dryRun: true, candidates: { prospects: 1, approved: 2 }, changed: 0 });
  });

  it("makes no CRM calls when the CRM isn't configured", async () => {
    configuredMock.mockReturnValue(false);

    const summary = await syncCrm(fakePrisma().prisma, { dryRun: false });

    expect(pushToProspectsMock).not.toHaveBeenCalled();
    expect(syncApprovedContactMock).not.toHaveBeenCalled();
    expect(summary.configured).toBe(false);
  });

  it("sends each user to its collection with the split name", async () => {
    const summary = await syncCrm(fakePrisma().prisma, { dryRun: false });

    expect(pushToProspectsMock).toHaveBeenCalledWith({
      email: "pending@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(syncApprovedContactMock).toHaveBeenCalledWith({
      email: "member@example.org",
      firstName: "Grace",
      lastName: "Hopper",
    });
    expect(syncApprovedContactMock).toHaveBeenCalledWith({
      email: "admin@example.org",
      firstName: "Alan",
      lastName: undefined,
    });
    expect(summary).toMatchObject({ changed: 3, unchanged: 0, failed: [] });
  });

  it("reports a repeat run with nothing to do as all unchanged", async () => {
    pushToProspectsMock.mockResolvedValue({ ok: true, value: { contactId: "c", changed: false } });
    syncApprovedContactMock.mockResolvedValue({ ok: true, value: { contactId: "c", warnings: [], changed: false } });

    const summary = await syncCrm(fakePrisma().prisma, { dryRun: false });

    expect(summary).toMatchObject({ changed: 0, unchanged: 3, failed: [] });
  });

  it("records a failure and carries on with the next user", async () => {
    pushToProspectsMock.mockResolvedValue({ ok: false, reason: "unauthorized:nope" });
    syncApprovedContactMock
      .mockResolvedValueOnce({ ok: true, value: { contactId: "c", warnings: ["profile_type_update_failed:x"], changed: true } })
      .mockResolvedValueOnce({ ok: true, value: { contactId: "c", warnings: [], changed: false } });

    const summary = await syncCrm(fakePrisma().prisma, { dryRun: false });

    expect(summary.failed).toEqual([
      { email: "pending@example.org", target: "prospects", reason: "unauthorized:nope" },
    ]);
    expect(summary).toMatchObject({ changed: 1, unchanged: 1 });
    expect(summary.warnings).toEqual([
      { email: "member@example.org", warnings: ["profile_type_update_failed:x"] },
    ]);
  });
});

describe("formatCrmSyncSummary", () => {
  const base: CrmSyncSummary = {
    configured: true,
    dryRun: false,
    candidates: { prospects: 1, approved: 2 },
    changed: 1,
    unchanged: 1,
    failed: [{ email: "a@b.org", target: "prospects", reason: "boom" }],
    warnings: [{ email: "c@d.org", warnings: ["w1"] }],
  };

  it("lists counts, failures and warnings after a real run", () => {
    expect(formatCrmSyncSummary(base)).toBe(
      [
        "3 self-signups (1 pending → prospects, 2 approved → approved). Changed 1, unchanged 1, failed 1.",
        "  failed a@b.org (prospects): boom",
        "  warning c@d.org: w1",
      ].join("\n"),
    );
  });

  it("says when nothing was synced and why", () => {
    expect(formatCrmSyncSummary({ ...base, dryRun: true })).toContain("Dry run: no CRM calls made");
    expect(formatCrmSyncSummary({ ...base, configured: false })).toContain("CRM not configured");
  });
});

describe("scheduled sync", () => {
  afterEach(() => {
    stopCrmSyncWorker();
    vi.useRealTimers();
  });

  it("doesn't start without an interval or without CRM config", () => {
    const { prisma } = fakePrisma();
    expect(startCrmSyncWorker(prisma, undefined)).toBe(false);
    configuredMock.mockReturnValue(false);
    expect(startCrmSyncWorker(prisma, 24)).toBe(false);
  });

  it("runs once after boot, then on the interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { prisma, userFindMany } = fakePrisma();

    expect(startCrmSyncWorker(prisma, 1)).toBe(true);
    expect(startCrmSyncWorker(prisma, 1)).toBe(false); // already started
    await vi.advanceTimersByTimeAsync(120_000);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(userFindMany).toHaveBeenCalledTimes(2);
  });

  it("never throws when a run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { prisma, userFindMany } = fakePrisma();
    userFindMany.mockRejectedValue(new Error("db down"));

    await expect(runScheduledCrmSync(prisma)).resolves.toBeUndefined();
  });
});
