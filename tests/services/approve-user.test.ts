/**
 * Approving a pending user (services/approve-user.ts): the role flip is
 * authoritative, the approval email is sent by CLEAR itself, and the CRM is
 * an optional mirror. Neither side effect can undo the approval, and an
 * unconfigured CRM is not reported as a problem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, syncApprovedContactMock, logActivityMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  syncApprovedContactMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

vi.mock("../../src/utils/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/env.js")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) =>
        prop === "BETTER_AUTH_URL" ? "https://api.example.test" : Reflect.get(target, prop),
    }),
  };
});

vi.mock("../../src/services/messaging/index.js", async () => {
  const templates = await import("../../src/services/messaging/templates.js");
  return {
    getEmailProvider: vi.fn(async () => ({ send: sendMock })),
    templates,
  };
});

vi.mock("../../src/services/exponential.js", () => ({
  syncApprovedContact: syncApprovedContactMock,
}));

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { accountApproved } from "../../src/services/messaging/templates.js";
import { sendApprovalEmail } from "../../src/services/approval-email.js";
import {
  approvalSummary,
  approveUserById,
  type ApproveUserResult,
} from "../../src/services/approve-user.js";

const pendingUser = {
  id: "u1",
  email: "ada@example.org",
  name: "Ada Lovelace",
  role: "pending",
  isActive: true,
};

/** In-memory stand-in for the one user row. `updateMany` applies its
 *  `role` guard against the live row, like the real conditional UPDATE, so
 *  overlapping approvals race the way they would in Postgres. */
function fakePrisma(user: typeof pendingUser | null = pendingUser) {
  const row = user ? { ...user } : null;
  const updateMany = vi.fn(
    async ({ where, data }: { where: { id: string; role: string }; data: { role: string } }) => {
      if (!row || row.id !== where.id || row.role !== where.role) return { count: 0 };
      row.role = data.role;
      return { count: 1 };
    },
  );
  const prisma = {
    user: { findUnique: vi.fn(async () => (row ? { ...row } : null)), updateMany },
  } as unknown as PrismaClient;
  return { prisma, updateMany };
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(true);
  syncApprovedContactMock.mockReset().mockResolvedValue({ ok: false, reason: "not_configured" });
  logActivityMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("accountApproved template", () => {
  it("is CLEAR-branded, links to API keys, and never mentions Exponential", () => {
    const mail = accountApproved("Ada", "https://api.example.test/portal#api-keys");

    expect(mail.subject).toBe("Your CLEAR account is approved");
    expect(mail.textBody).toContain("Hi Ada");
    expect(mail.textBody).toContain("https://api.example.test/portal#api-keys");
    expect(mail.htmlBody).toContain('href="https://api.example.test/portal#api-keys"');
    for (const part of [mail.subject, mail.textBody, mail.htmlBody]) {
      expect(part).not.toMatch(/Exponential/i);
    }
  });

  it("escapes the user's name in the HTML body", () => {
    const mail = accountApproved("<img src=x onerror=alert(1)>", "https://x.test/portal#api-keys");
    expect(mail.htmlBody).not.toContain("<img src=x");
    expect(mail.htmlBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("falls back to a generic greeting without a name", () => {
    expect(accountApproved("  ", "https://x.test").textBody).toContain("Hi there");
  });
});

describe("approveUserById", () => {
  it("flips the role to member and emails the user", async () => {
    const { prisma, updateMany } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "u1", role: "pending" },
      data: { role: "member" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe("ada@example.org");
    expect(mail.subject).toBe("Your CLEAR account is approved");
    expect(mail.textBody).toContain("Hi Ada Lovelace");
    expect(mail.textBody).toContain("https://api.example.test/portal#api-keys");
    expect(result).toMatchObject({
      user: { id: "u1", role: "member" },
      emailSent: true,
      emailError: null,
    });
  });

  it("does not report an unconfigured CRM as a problem", async () => {
    const { prisma } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(result.crmMoved).toBe(false);
    expect(result.crmWarnings).toEqual([]);
  });

  it("sends the email even when the CRM sync fails, and reports the failure", async () => {
    syncApprovedContactMock.mockResolvedValue({ ok: false, reason: "contact_upsert_failed:network_error:boom" });
    const { prisma } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(result.emailSent).toBe(true);
    expect(result.crmMoved).toBe(false);
    expect(result.crmWarnings).toEqual(["crm_sync_failed:contact_upsert_failed:network_error:boom"]);
  });

  it("passes the split name to the CRM and keeps its partial-sync warnings", async () => {
    syncApprovedContactMock.mockResolvedValue({
      ok: true,
      value: { contactId: "c1", warnings: ["remove_from_prospects_failed:not_found"] },
    });
    const { prisma } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(syncApprovedContactMock).toHaveBeenCalledWith({
      email: "ada@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(result.crmMoved).toBe(true);
    expect(result.crmWarnings).toEqual(["remove_from_prospects_failed:not_found"]);
  });

  it("keeps the approval when the email provider throws, and says why", async () => {
    sendMock.mockRejectedValue(new Error("Postmark error: inactive recipient"));
    const { prisma, updateMany } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(updateMany).toHaveBeenCalled();
    expect(result.user.role).toBe("member");
    expect(result.emailSent).toBe(false);
    expect(result.emailError).toBe("Postmark error: inactive recipient");
  });

  it("treats a provider that returns false as a failed send", async () => {
    sendMock.mockResolvedValue(false);
    const { prisma } = fakePrisma();

    const result = await approveUserById(prisma, "admin1", "u1");

    expect(result.emailSent).toBe(false);
    expect(result.emailError).toBe("provider_rejected");
  });

  it("records the email and CRM outcome in the activity log", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const { prisma } = fakePrisma();

    await approveUserById(prisma, "admin1", "u1");

    expect(logActivityMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        userId: "admin1",
        action: "user.approved",
        resourceId: "u1",
        metadata: expect.objectContaining({ emailSent: false, emailError: "smtp down" }),
      }),
    );
  });

  it("refuses a user who is not pending, without emailing them", async () => {
    const { prisma, updateMany } = fakePrisma({ ...pendingUser, role: "member" });

    await expect(approveUserById(prisma, "admin1", "u1")).rejects.toThrow(/not pending/);
    expect(updateMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(syncApprovedContactMock).not.toHaveBeenCalled();
  });

  it("emails once when two approvals overlap", async () => {
    const { prisma } = fakePrisma();

    // Both requests read the row while it is still pending.
    const results = await Promise.allSettled([
      approveUserById(prisma, "admin1", "u1"),
      approveUserById(prisma, "admin2", "u1"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/already approved/);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(syncApprovedContactMock).toHaveBeenCalledTimes(1);
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendApprovalEmail", () => {
  it("reports a stalled provider as a timeout instead of waiting on it", async () => {
    sendMock.mockReturnValue(new Promise(() => {}));

    const result = await sendApprovalEmail({ email: "ada@example.org", name: "Ada" }, 20);

    expect(result).toEqual({ ok: false, reason: "timed out after 20ms" });
  });
});

describe("approvalSummary", () => {
  const base: ApproveUserResult = {
    user: { id: "u1", email: "ada@example.org", name: "Ada", role: "member", isActive: true },
    emailSent: true,
    emailError: null,
    crmMoved: false,
    crmWarnings: [],
  };

  it("confirms the email on the happy path", () => {
    expect(approvalSummary(base)).toBe("Approved. Approval email sent.");
  });

  it("tells the admin when the user was not emailed", () => {
    expect(approvalSummary({ ...base, emailSent: false, emailError: "smtp down" })).toBe(
      "Approved, but the approval email failed (smtp down). Let them know another way.",
    );
  });

  it("appends CRM warnings", () => {
    expect(approvalSummary({ ...base, crmWarnings: ["crm_sync_failed:x"] })).toBe(
      "Approved. Approval email sent. CRM sync issues: crm_sync_failed:x",
    );
  });
});
