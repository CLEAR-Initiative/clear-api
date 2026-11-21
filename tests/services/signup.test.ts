/**
 * The Better Auth `user.create.after` hook body (services/signup.ts) and the
 * maintainer notifications it sends (services/signup-notify.ts). Every side
 * effect is best-effort: a dead mail provider or CRM must never fail signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, pushToProspectsMock, logActivityMock, envOverrides } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  pushToProspectsMock: vi.fn(),
  logActivityMock: vi.fn(),
  envOverrides: { SIGNUP_NOTIFY_EMAILS: [] as string[] },
}));

vi.mock("../../src/utils/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/env.js")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) =>
        prop === "SIGNUP_NOTIFY_EMAILS"
          ? envOverrides.SIGNUP_NOTIFY_EMAILS
          : prop === "BETTER_AUTH_URL"
            ? "https://api.example.test"
            : Reflect.get(target, prop),
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
  pushToProspects: pushToProspectsMock,
}));

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

import { onDeveloperSignedUp, splitName } from "../../src/services/signup.js";
import { notifyMaintainersOfProfile } from "../../src/services/signup-notify.js";

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(true);
  pushToProspectsMock.mockReset().mockResolvedValue({ ok: true, value: { contactId: "c1", changed: true } });
  logActivityMock.mockReset().mockResolvedValue(undefined);
  envOverrides.SIGNUP_NOTIFY_EMAILS = ["maint@clear.test", "ops@clear.test"];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const subjects = () => sendMock.mock.calls.map((c) => c[0].subject as string);

describe("onDeveloperSignedUp", () => {
  it("acks the registrant and tells every maintainer", async () => {
    await onDeveloperSignedUp({ id: "u1", name: "Ada Lovelace", email: "ada@example.org" });

    const notify = sendMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m.subject === "New developer sign-up: Ada Lovelace <ada@example.org>");
    expect(notify.map((m) => m.to).sort()).toEqual(["maint@clear.test", "ops@clear.test"]);
    expect(notify[0].textBody).toContain("https://api.example.test/portal/admin?tab=users");
    expect(notify[0].htmlBody).toContain('href="https://api.example.test/portal/admin?tab=users"');

    const ack = sendMock.mock.calls.map((c) => c[0]).filter((m) => m.to === "ada@example.org");
    expect(ack).toHaveLength(1);
    expect(ack[0].textBody).toContain("https://api.example.test/portal/welcome");
    expect(pushToProspectsMock).toHaveBeenCalledWith({
      email: "ada@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("still succeeds when every email send throws", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    await expect(
      onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" }),
    ).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(3); // ack + two maintainers
  });

  it("still succeeds when the CRM call throws", async () => {
    pushToProspectsMock.mockRejectedValue(new Error("network"));
    await expect(
      onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" }),
    ).resolves.toBeUndefined();
  });

  it("records a CRM failure in the activity log", async () => {
    pushToProspectsMock.mockResolvedValue({ ok: false, reason: "unauthorized:nope" });

    await onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" });

    expect(logActivityMock).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      action: "user.crm_sync_failed",
      resourceType: "user",
      resourceId: "u1",
      metadata: { email: "ada@example.org", stage: "signup", reason: "unauthorized:nope" },
    });
  });

  it("records a CRM call that throws", async () => {
    pushToProspectsMock.mockRejectedValue(new Error("network"));

    await onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" });

    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "threw:network" }) }),
    );
  });

  it("logs nothing when the CRM sync works or isn't configured", async () => {
    await onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" });
    pushToProspectsMock.mockResolvedValue({ ok: false, reason: "not_configured" });
    await onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" });

    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("sends no maintainer email when SIGNUP_NOTIFY_EMAILS is empty", async () => {
    envOverrides.SIGNUP_NOTIFY_EMAILS = [];
    await onDeveloperSignedUp({ id: "u1", name: "Ada", email: "ada@example.org" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("ada@example.org");
  });

  it("keeps a CR/LF in the name out of the subject line", async () => {
    await onDeveloperSignedUp({ id: "u1", name: "Ada\r\nBcc: evil@x.test", email: "ada@example.org" });
    expect(subjects().some((s) => /[\r\n]/.test(s))).toBe(false);
  });
});

describe("notifyMaintainersOfProfile", () => {
  it("sends the submitted details, escaped in HTML", async () => {
    await notifyMaintainersOfProfile(
      { name: "Ada", email: "ada@example.org" },
      {
        organisation: "<script>alert(1)</script>",
        organisationWebsite: null,
        personalWebsite: "https://ada.example.org/",
        linkedinUrl: null,
        githubUrl: "https://github.com/ada",
        contributionInterest: "Data pipeline & LLMs",
      },
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.subject).toBe("Developer details: Ada <ada@example.org>");
    expect(mail.textBody).toContain("GitHub: https://github.com/ada");
    expect(mail.htmlBody).not.toContain("<script>alert(1)</script>");
    expect(mail.htmlBody).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.htmlBody).toContain("Data pipeline &amp; LLMs");
  });

  it("swallows provider errors", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    await expect(
      notifyMaintainersOfProfile(
        { name: "Ada", email: "ada@example.org" },
        {
          organisation: null,
          organisationWebsite: null,
          personalWebsite: null,
          linkedinUrl: null,
          githubUrl: null,
          contributionInterest: null,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("splitName", () => {
  it("splits on the first space", () => {
    expect(splitName("Ada King Lovelace")).toEqual({ firstName: "Ada", lastName: "King Lovelace" });
    expect(splitName("Ada")).toEqual({ firstName: "Ada", lastName: undefined });
    expect(splitName("  ")).toEqual({ firstName: undefined, lastName: undefined });
  });
});
