/**
 * DB-free tests for `matchDigestRecipients`: the Alert Digest's matching
 * rule (type, location or an ancestor of it, severity floor) and its query
 * shape (one batched ancestor lookup, one subscription query).
 *
 * The fake Prisma below answers `locations.findMany` and
 * `userAlertSubscriptions.findMany` from in-memory tables, applying the
 * same `where` the real queries send.
 */

import { describe, it, expect, vi } from "vitest";
import { matchDigestRecipients, type DigestAlert } from "../../src/services/alert-digest.js";

interface Sub {
  userId: string;
  alertType: string;
  locationId: string;
  minSeverity: number;
  frequency?: string;
  active?: boolean;
}

// country → state → district
const LOCATIONS = [
  { id: "country", ancestorIds: [] },
  { id: "state", ancestorIds: ["country"] },
  { id: "district", ancestorIds: ["state", "country"] },
  { id: "elsewhere", ancestorIds: [] },
];

function fakePrisma(subs: Sub[]) {
  const locations = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      LOCATIONS.filter((l) => where.id.in.includes(l.id)),
    ),
  };
  const userAlertSubscriptions = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          active: boolean;
          frequency: string;
          alertType: { in: string[] };
          locationId: { in: string[] };
        };
      }) =>
        subs
          .map((s) => ({ frequency: "daily", active: true, ...s }))
          .filter(
            (s) =>
              s.active === where.active &&
              s.frequency === where.frequency &&
              where.alertType.in.includes(s.alertType) &&
              where.locationId.in.includes(s.locationId),
          ),
    ),
  };
  return { prisma: { locations, userAlertSubscriptions } as never, locations, userAlertSubscriptions };
}

function alert(id: string, event: Partial<DigestAlert["event"]> = {}): DigestAlert {
  return {
    id,
    event: {
      types: ["FL"],
      originId: null,
      destinationId: null,
      locationId: "district",
      severity: 3,
      ...event,
    },
  };
}

describe("matchDigestRecipients", () => {
  it("matches on the Alert's type", async () => {
    const { prisma } = fakePrisma([
      { userId: "u-flood", alertType: "FL", locationId: "district", minSeverity: 1 },
      { userId: "u-quake", alertType: "EQ", locationId: "district", minSeverity: 1 },
    ]);
    const out = await matchDigestRecipients(prisma, [alert("a1", { types: ["FL", "DR"] })], "daily");
    expect(out).toEqual(new Map([["a1", ["u-flood"]]]));
  });

  it("matches a subscription on any ancestor of the origin, destination or general location", async () => {
    const { prisma } = fakePrisma([
      { userId: "u-country", alertType: "FL", locationId: "country", minSeverity: 1 },
      { userId: "u-state", alertType: "FL", locationId: "state", minSeverity: 1 },
      { userId: "u-elsewhere", alertType: "FL", locationId: "elsewhere", minSeverity: 1 },
    ]);
    const viaOrigin = alert("a1", { locationId: null, originId: "district" });
    const viaDestination = alert("a2", { locationId: null, destinationId: "state" });
    const out = await matchDigestRecipients(prisma, [viaOrigin, viaDestination], "daily");
    expect(out.get("a1")?.sort()).toEqual(["u-country", "u-state"]);
    expect(out.get("a2")?.sort()).toEqual(["u-country", "u-state"]);
  });

  it("matches only subscriptions whose severity floor the Event clears", async () => {
    const { prisma } = fakePrisma([
      { userId: "u-all", alertType: "FL", locationId: "district", minSeverity: 1 },
      { userId: "u-3", alertType: "FL", locationId: "district", minSeverity: 3 },
      { userId: "u-4", alertType: "FL", locationId: "district", minSeverity: 4 },
    ]);
    const out = await matchDigestRecipients(
      prisma,
      [alert("sev3", { severity: 3 }), alert("unknown", { severity: null })],
      "daily",
    );
    expect(out.get("sev3")?.sort()).toEqual(["u-3", "u-all"]);
    // Unknown severity reaches only all-severities subscribers.
    expect(out.get("unknown")).toEqual(["u-all"]);
  });

  it("counts a user once per Alert and leaves out Alerts nobody matches", async () => {
    const { prisma } = fakePrisma([
      { userId: "u1", alertType: "FL", locationId: "country", minSeverity: 1 },
      { userId: "u1", alertType: "FL", locationId: "district", minSeverity: 1 },
    ]);
    const out = await matchDigestRecipients(
      prisma,
      [alert("a1"), alert("a2", { types: ["EQ"] })],
      "daily",
    );
    expect(out).toEqual(new Map([["a1", ["u1"]]]));
  });

  it("looks up every Alert's ancestors in one query and filters subscriptions by frequency", async () => {
    const { prisma, locations, userAlertSubscriptions } = fakePrisma([
      { userId: "u-daily", alertType: "FL", locationId: "country", minSeverity: 1 },
      { userId: "u-weekly", alertType: "FL", locationId: "country", minSeverity: 1, frequency: "weekly" },
    ]);
    const alerts = [alert("a1"), alert("a2", { locationId: "state" }), alert("a3", { originId: "district" })];
    const out = await matchDigestRecipients(prisma, alerts, "weekly");

    expect(locations.findMany).toHaveBeenCalledTimes(1);
    expect(locations.findMany.mock.calls[0]![0].where.id.in.sort()).toEqual(["district", "state"]);
    expect(userAlertSubscriptions.findMany).toHaveBeenCalledTimes(1);
    expect(userAlertSubscriptions.findMany.mock.calls[0]![0].where).toMatchObject({
      active: true,
      frequency: "weekly",
    });
    expect([...out.values()]).toEqual([["u-weekly"], ["u-weekly"], ["u-weekly"]]);
  });

  it("queries nothing for Alerts without a location", async () => {
    const { prisma, locations, userAlertSubscriptions } = fakePrisma([]);
    const out = await matchDigestRecipients(prisma, [alert("a1", { locationId: null })], "daily");
    expect(out.size).toBe(0);
    expect(locations.findMany).not.toHaveBeenCalled();
    expect(userAlertSubscriptions.findMany).not.toHaveBeenCalled();
  });
});
