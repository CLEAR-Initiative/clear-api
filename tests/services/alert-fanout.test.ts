/**
 * Unit tests for `fanOutAlertWebhooks` — the clear_alert webhook matcher.
 * DB-free: prisma is a stub, the team location-scope resolver and
 * `attemptDelivery` are mocked so we exercise ONLY the matching rules and
 * the per-match delivery fan-out.
 *
 * Matching rules under test (from the service's doc-comment):
 *   - location scope: an in-scope team matches, out-of-scope doesn't, a
 *     wide-open team (no teamLocations → undefined scope) matches any location
 *   - alertTypeFilter: a non-empty filter must intersect the event's types
 *   - minSeverity: a set floor excludes lower severities AND null severity
 *   - one WebhookDelivery per match (alert.created payload), then
 *     attemptDelivery is fired per delivery.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

const attemptDelivery = vi.fn(async () => ({
  status: "succeeded" as const,
  responseStatus: 200,
  attempt: 1,
}));
vi.mock("../../src/services/webhook/deliver.js", () => ({ attemptDelivery }));

// teamId → scope location ids (undefined = team with no bindings = wide-open).
const scopeByTeam = new Map<string, string[] | undefined>();
vi.mock("../../src/utils/location-scope.js", () => ({
  getTeamScopeLocationIds: vi.fn(
    async (_prisma: unknown, teamId: string) => scopeByTeam.get(teamId),
  ),
}));

const { fanOutAlertWebhooks } = await import(
  "../../src/services/webhook/alert-fanout.js"
);

interface Sub {
  id: string;
  teamId: string;
  alertTypeFilter: string[];
  minSeverity: number | null;
}

function makePrisma(subs: Sub[]) {
  const create = vi.fn(
    async (args: { data: Record<string, unknown> }) => ({ id: `d-${args.data.subscriptionId}` }),
  );
  const subsFindMany = vi.fn(async () => subs);
  const prisma = {
    webhookSubscription: { findMany: subsFindMany },
    locations: {
      findMany: vi.fn(async () => [{ name: "North Darfur" }]),
    },
    webhookDelivery: { create },
  } as unknown as PrismaClient;
  return { prisma, create, subsFindMany };
}

const ALERT = { id: "al-1", status: "published", createdAt: new Date("2026-01-01T00:00:00Z") };

function event(overrides: Partial<Parameters<typeof fanOutAlertWebhooks>[2]> = {}) {
  return {
    id: "ev-1",
    title: "Flooding",
    description: "River burst",
    types: ["FL"],
    severity: 3,
    originId: "loc-A",
    destinationId: null,
    locationId: null,
    ...overrides,
  };
}

afterEach(() => {
  attemptDelivery.mockClear();
  scopeByTeam.clear();
});

describe("fanOutAlertWebhooks — location scope", () => {
  it("matches an in-scope team and not an out-of-scope one", async () => {
    scopeByTeam.set("team-in", ["loc-A", "loc-B"]);
    scopeByTeam.set("team-out", ["loc-Z"]);
    const { prisma, create } = makePrisma([
      { id: "s-in", teamId: "team-in", alertTypeFilter: [], minSeverity: null },
      { id: "s-out", teamId: "team-out", alertTypeFilter: [], minSeverity: null },
    ]);

    const count = await fanOutAlertWebhooks(prisma, ALERT, event(), "https://app.test");

    expect(count).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.data?.subscriptionId).toBe("s-in");
  });

  it("a wide-open team (no location bindings) matches any location", async () => {
    // team-wide intentionally absent from scopeByTeam → scope undefined.
    const { prisma, create } = makePrisma([
      { id: "s-wide", teamId: "team-wide", alertTypeFilter: [], minSeverity: null },
    ]);

    const count = await fanOutAlertWebhooks(
      prisma,
      ALERT,
      event({ originId: "loc-anything" }),
      "https://app.test",
    );

    expect(count).toBe(1);
    expect(create.mock.calls[0]?.[0]?.data?.subscriptionId).toBe("s-wide");
  });
});

describe("fanOutAlertWebhooks — alertTypeFilter", () => {
  it("fires only when the filter intersects the event types", async () => {
    scopeByTeam.set("t", ["loc-A"]);
    const { prisma, create } = makePrisma([
      { id: "s-match", teamId: "t", alertTypeFilter: ["FL", "TC"], minSeverity: null },
      { id: "s-miss", teamId: "t", alertTypeFilter: ["EQ"], minSeverity: null },
    ]);

    const count = await fanOutAlertWebhooks(
      prisma,
      ALERT,
      event({ types: ["FL"] }),
      "https://app.test",
    );

    expect(count).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.data?.subscriptionId).toBe("s-match");
  });
});

describe("fanOutAlertWebhooks — minSeverity floor", () => {
  it("excludes alerts below the floor and keeps those at/above it", async () => {
    scopeByTeam.set("t", ["loc-A"]);
    const { prisma, create } = makePrisma([
      { id: "s-low", teamId: "t", alertTypeFilter: [], minSeverity: 4 },
      { id: "s-ok", teamId: "t", alertTypeFilter: [], minSeverity: 2 },
    ]);

    const count = await fanOutAlertWebhooks(
      prisma,
      ALERT,
      event({ severity: 3 }),
      "https://app.test",
    );

    expect(count).toBe(1);
    expect(create.mock.calls[0]?.[0]?.data?.subscriptionId).toBe("s-ok");
  });

  it("a set floor excludes null-severity alerts", async () => {
    scopeByTeam.set("t", ["loc-A"]);
    const { prisma } = makePrisma([
      { id: "s-floor", teamId: "t", alertTypeFilter: [], minSeverity: 1 },
    ]);

    const count = await fanOutAlertWebhooks(
      prisma,
      ALERT,
      event({ severity: null }),
      "https://app.test",
    );

    expect(count).toBe(0);
  });

  it("a null floor lets null-severity alerts through", async () => {
    scopeByTeam.set("t", ["loc-A"]);
    const { prisma } = makePrisma([
      { id: "s-any", teamId: "t", alertTypeFilter: [], minSeverity: null },
    ]);

    const count = await fanOutAlertWebhooks(
      prisma,
      ALERT,
      event({ severity: null }),
      "https://app.test",
    );

    expect(count).toBe(1);
  });
});

describe("fanOutAlertWebhooks — delivery", () => {
  it("creates one delivery per match with an alert.created payload and fires attemptDelivery", async () => {
    scopeByTeam.set("t1", ["loc-A"]);
    scopeByTeam.set("t2", ["loc-A"]);
    const { prisma, create } = makePrisma([
      { id: "s-1", teamId: "t1", alertTypeFilter: [], minSeverity: null },
      { id: "s-2", teamId: "t2", alertTypeFilter: [], minSeverity: null },
    ]);

    const count = await fanOutAlertWebhooks(prisma, ALERT, event(), "https://app.test");

    expect(count).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    const firstData = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(firstData.eventId).toBe("alert:al-1");
    expect(firstData.eventType).toBe("alert.created");
    const body = firstData.requestBody as {
      type: string;
      alert: { id: string; status: string };
      event: { id: string; types: string[]; locations: string[] };
      url: string;
    };
    expect(body.type).toBe("alert.created");
    expect(body.alert).toMatchObject({ id: "al-1", status: "published" });
    expect(body.event).toMatchObject({ id: "ev-1", types: ["FL"] });
    expect(body.event.locations).toEqual(["North Darfur"]);
    expect(body.url).toBe("https://app.test/event/ev-1?from=webhook");

    // attemptDelivery fired once per created delivery (fire-and-forget).
    await vi.waitFor(() => expect(attemptDelivery).toHaveBeenCalledTimes(2));
  });

  it("returns 0 and creates nothing when no subscriptions exist", async () => {
    const { prisma, create } = makePrisma([]);
    const count = await fanOutAlertWebhooks(prisma, ALERT, event(), "https://app.test");
    expect(count).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(attemptDelivery).not.toHaveBeenCalled();
  });
});
