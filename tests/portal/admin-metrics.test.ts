import { describe, expect, it } from "vitest";
import { renderAdminMetrics } from "../../src/portal/template.js";

const baseMetrics = {
  engagement: {
    dau: 1,
    mau: 5,
    totalUsers: 10,
    usersByRole: { admin: 1, analyst: 2, viewer: 6, pending: 1 },
  },
  content: {
    signals: 100,
    events: 20,
    publishedAlerts: 3,
    crises: 2,
  },
  org: {
    organisations: 4,
    teams: 8,
  },
};

describe("renderAdminMetrics — newsletter card", () => {
  it("shows not configured when the API key is absent", () => {
    const html = renderAdminMetrics({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      metrics: {
        ...baseMetrics,
        newsletter: { configured: false, count: null },
      },
    });

    expect(html).toContain("Newsletter subscribers");
    expect(html).toContain("BUTTONDOWN_API_KEY not configured.");
  });

  it("shows the subscriber count when configured", () => {
    const html = renderAdminMetrics({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      metrics: {
        ...baseMetrics,
        newsletter: { configured: true, count: 1284 },
      },
    });

    expect(html).toContain("1,284");
    expect(html).toContain("Subscribers on the public Buttondown list.");
  });

  it("shows an error hint when Buttondown fails", () => {
    const html = renderAdminMetrics({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      metrics: {
        ...baseMetrics,
        newsletter: {
          configured: true,
          count: null,
          error: "Buttondown API unavailable",
        },
      },
    });

    expect(html).toContain("Buttondown API unavailable");
  });
});
