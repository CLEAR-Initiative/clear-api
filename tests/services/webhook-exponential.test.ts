import { describe, it, expect, vi } from "vitest";
import {
  alertService,
  exponentialBugConfigFromEnv,
  fileBugTicket,
} from "../../src/services/webhook/exponential.js";

const payload = {
  alias: "issue.new",
  attachments: [
    {
      title: "TypeError: boom",
      title_link: "https://sentry.clearinitiative.io/clearinitiative/issues/42",
      fields: [{ title: "Project", value: "Clear-dagster" }],
    },
  ],
};
const config = { webhookUrl: "https://exp.example/api/webhooks/sentry/abc", token: "s3cret" };
const ticketUrl = "https://exp.example/w/clear/products/clear/tickets/1702";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("exponentialBugConfigFromEnv", () => {
  it("is null unless both vars are set", () => {
    expect(exponentialBugConfigFromEnv({ EXPONENTIAL_BUG_WEBHOOK_URL: "x" })).toBeNull();
    expect(
      exponentialBugConfigFromEnv({
        EXPONENTIAL_BUG_WEBHOOK_URL: "x",
        EXPONENTIAL_BUG_WEBHOOK_TOKEN: "y",
      }),
    ).toEqual({ webhookUrl: "x", token: "y" });
  });
});

describe("alertService", () => {
  it("reads the project field as a slug, then the top-level project", () => {
    expect(alertService(payload)).toBe("clear-dagster");
    expect(alertService({ project: "clear-api" })).toBe("clear-api");
    expect(alertService({})).toBeNull();
    expect(alertService(null)).toBeNull();
    expect(alertService({ attachments: [null], project: 7 })).toBeNull();
  });
});

describe("fileBugTicket", () => {
  it("forwards the payload with the token in a header and returns the ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ created: true, ticketId: "t1", ticketNumber: 1702, ticketUrl }));
    const ticket = await fileBugTicket(config, payload, { fetch: fetchMock });
    expect(ticket).toEqual({ number: 1702, url: ticketUrl });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.example/api/webhooks/sentry/abc?service=clear-dagster");
    expect(url).not.toContain("s3cret");
    expect((init.headers as Record<string, string>)["X-Webhook-Token"]).toBe("s3cret");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("returns null for an ignored event, a bad link, an error status and a network error", async () => {
    const cases = [
      vi.fn().mockResolvedValue(json({ message: "Ignored glitchtip event" })),
      vi.fn().mockResolvedValue(json({ ticketNumber: 1, ticketUrl: "javascript:alert(1)" })),
      vi.fn().mockResolvedValue(json({ error: "Invalid signature" }, 401)),
      vi.fn().mockRejectedValue(new Error("down")),
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const fetchMock of cases) {
      expect(await fileBugTicket(config, payload, { fetch: fetchMock })).toBeNull();
    }
    errors.mockRestore();
  });
});
