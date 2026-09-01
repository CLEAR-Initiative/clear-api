import { describe, expect, it, vi, beforeEach } from "vitest";
import { signupAcknowledgement } from "../../src/services/messaging/templates.js";

describe("signupAcknowledgement", () => {
  it("is CLEAR-branded and never mentions Exponential", () => {
    const mail = signupAcknowledgement(
      "James",
      "https://api.clearinitiative.io/portal/login",
    );

    expect(mail.subject).toContain("CLEAR API");
    expect(mail.textBody).toContain("Hi James");
    expect(mail.textBody).toContain("The CLEAR team");
    expect(mail.textBody).toContain("https://api.clearinitiative.io/portal/login");
    expect(mail.htmlBody).toContain("The CLEAR team");
    expect(mail.textBody).not.toMatch(/Exponential/i);
    expect(mail.htmlBody).not.toMatch(/Exponential/i);
    expect(mail.subject).not.toMatch(/Exponential/i);
  });
});

const sendMock = vi.fn();
vi.mock("../../src/services/messaging/index.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send: sendMock })),
  templates: {
    signupAcknowledgement: (name: string, url: string) => ({
      subject: "ack",
      textBody: `t ${name} ${url}`,
      htmlBody: "<p>",
    }),
  },
}));

describe("sendSignupAcknowledgement", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue(undefined);
  });

  it("sends via the configured email provider", async () => {
    const { sendSignupAcknowledgement } = await import(
      "../../src/services/signup-ack.js"
    );
    await sendSignupAcknowledgement({ email: "a@b.dev", name: "Ada" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe("a@b.dev");
    expect(sendMock.mock.calls[0][0].subject).toBe("ack");
  });

  it("swallows provider errors so signup is not blocked", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const { sendSignupAcknowledgement } = await import(
      "../../src/services/signup-ack.js"
    );
    await expect(
      sendSignupAcknowledgement({ email: "a@b.dev", name: "Ada" }),
    ).resolves.toBeUndefined();
  });
});
