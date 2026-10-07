/**
 * Task outcome fan-out (ADR-0010, V2): who is told, what the in-app row
 * says, and who gets an email with the error. DB-free: Prisma and the
 * email provider are stubs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const sendBulk = vi.fn(async (msgs: unknown[]) => msgs.map(() => true));
vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: async () => ({ sendBulk }),
}));

const { notifyTaskOutcome, taskOutcomeMessage, taskRecipients } = await import("../../src/services/task-notifications.js");

const TASK = {
  id: "t-1",
  kind: "event.impact_prior",
  subjectType: "event",
  subjectId: "ev-1",
  requesterId: "u-req",
  teamId: "team-a",
  outcome: "produced",
  lastError: null,
};

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, email: `${id}@example.test`, language: "en", emailNotification: false, ...extra,
});

function makePrisma(users: { requester?: unknown[]; admins?: unknown[]; analysts?: unknown[] } = {}) {
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.id) return users.requester ?? [];
    if (where.role === "admin") return users.admins ?? [];
    if (where.role === "analyst") return users.analysts ?? [];
    return [];
  });
  const createMany = vi.fn(async () => ({ count: 0 }));
  return { prisma: { user: { findMany }, notifications: { createMany } } as never, findMany, createMany };
}

afterEach(() => {
  sendBulk.mockClear();
});

describe("taskRecipients", () => {
  it("is the requester, platform admins and the team's analysts, de-duplicated, with who may see the error", async () => {
    const { prisma, findMany } = makePrisma({
      requester: [user("u-req")],
      admins: [user("u-admin"), user("u-req")],
      analysts: [user("u-an"), user("u-admin")],
    });
    const recipients = await taskRecipients(prisma, TASK);
    expect(Object.fromEntries(recipients.map((r) => [r.id, r.seesError]))).toEqual({
      "u-an": false,
      "u-req": true,
      "u-admin": true,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "analyst", isActive: true, teamMemberships: { some: { teamId: "team-a" } } } }),
    );
  });

  it("skips the team query without a team and the requester query for a rule-originated Task", async () => {
    const { prisma, findMany } = makePrisma({ admins: [user("u-admin")] });
    const recipients = await taskRecipients(prisma, { ...TASK, requesterId: null, teamId: null });
    expect(recipients.map((r) => r.id)).toEqual(["u-admin"]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("taskOutcomeMessage", () => {
  it("names the kind and how it ended", () => {
    expect(taskOutcomeMessage(TASK, "completed")).toBe("Impact prior proposed — review it");
    expect(taskOutcomeMessage({ ...TASK, outcome: "no_prior_found" }, "completed")).toBe("Impact prior: no prior found");
    expect(taskOutcomeMessage({ ...TASK, lastError: "x" }, "failed")).toBe("Impact prior enrichment failed");
  });

  it("names the source when the kind has one — several Workers report on one Event", () => {
    expect(taskOutcomeMessage({ ...TASK, kind: "event.impact_prior.clear" }, "completed")).toBe(
      "Impact prior from CLEAR data proposed — review it",
    );
    expect(taskOutcomeMessage({ ...TASK, kind: "event.impact_prior.web", outcome: "no_prior_found" }, "completed")).toBe(
      "Impact prior from the web: no prior found",
    );
    expect(taskOutcomeMessage({ ...TASK, kind: "event.impact_prior.web", outcome: "no_new_cases" }, "completed")).toBe(
      "Impact prior from the web: no new cases",
    );
    // The web kind proposes cases, each decided on its own (V4).
    expect(taskOutcomeMessage({ ...TASK, kind: "event.impact_prior.web" }, "completed")).toBe(
      "Impact prior from the web: cases proposed — review them",
    );
    expect(taskOutcomeMessage({ ...TASK, kind: "event.impact_prior.satellite", lastError: "x" }, "failed")).toBe(
      "Impact prior from satellite enrichment failed",
    );
    expect(taskOutcomeMessage({ ...TASK, kind: "event.other", lastError: "x" }, "failed")).toBe("event.other enrichment failed");
  });
});

describe("notifyTaskOutcome", () => {
  it("writes one in-app row per recipient, typed task, linking the Event page", async () => {
    const { prisma, createMany } = makePrisma({ requester: [user("u-req")], admins: [user("u-admin")] });
    await notifyTaskOutcome(prisma, TASK, "completed");
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { userId: "u-req", message: "Impact prior proposed — review it", notificationType: "task", actionUrl: "/event/ev-1", actionText: "View Event" },
        { userId: "u-admin", message: "Impact prior proposed — review it", notificationType: "task", actionUrl: "/event/ev-1", actionText: "View Event" },
      ],
    });
    expect(sendBulk).not.toHaveBeenCalled();
  });

  it("emails opted-in recipients, with the error only for those who may see it", async () => {
    const { prisma } = makePrisma({
      requester: [user("u-req", { emailNotification: true })],
      admins: [user("u-admin", { emailNotification: false })],
      analysts: [user("u-an", { emailNotification: true })],
    });
    await notifyTaskOutcome(prisma, { ...TASK, outcome: null, lastError: "model timed out" }, "failed");
    await new Promise((r) => setImmediate(r));
    expect(sendBulk).toHaveBeenCalledTimes(1);
    const msgs = sendBulk.mock.calls[0]![0] as Array<{ to: string; subject: string; textBody: string }>;
    expect(msgs.map((m) => m.to).sort()).toEqual(["u-an@example.test", "u-req@example.test"]);
    const byTo = Object.fromEntries(msgs.map((m) => [m.to, m]));
    expect(byTo["u-req@example.test"]!.textBody).toContain("model timed out");
    expect(byTo["u-an@example.test"]!.textBody).not.toContain("model timed out");
    expect(byTo["u-req@example.test"]!.textBody).toContain("/event/ev-1");
    expect(byTo["u-req@example.test"]!.subject).toContain("failed");
  });

  it("never throws: a failing write is logged, not raised", async () => {
    const { prisma, createMany } = makePrisma({ admins: [user("u-admin")] });
    createMany.mockRejectedValueOnce(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyTaskOutcome(prisma, TASK, "completed")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("does nothing when nobody is to be told", async () => {
    const { prisma, createMany } = makePrisma();
    await notifyTaskOutcome(prisma, { ...TASK, requesterId: null, teamId: null }, "completed");
    expect(createMany).not.toHaveBeenCalled();
  });
});
