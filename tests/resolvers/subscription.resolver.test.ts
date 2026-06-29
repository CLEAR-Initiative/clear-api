/**
 * Unit tests for `subscription.resolver.ts` (the alert/notification
 * subscription domain — NOT GraphQL transport subscriptions).
 *
 * DB-free: every `context.prisma.*` delegate is stubbed with `vi.fn()` and a
 * Context is hand-built per test. No real Prisma client, no database, no
 * `describeIfDb`. The resolver imports only `graphql` and the auth-guard
 * helpers (which operate purely on the Context), so nothing needs `vi.mock`.
 *
 * Coverage (branches with real logic):
 *   - Query.myAlertSubscriptions: auth gate + scoping to the caller.
 *   - Query.alertSubscriptionsByLocation: admin-only role gate + filter.
 *   - validateSeverity (via subscribeToAlerts/update): rejects non-integer,
 *     <1, >5; accepts 1..5; defaults to 1 when omitted.
 *   - subscribeToAlerts: auth gate, location-existence (NOT_FOUND), duplicate
 *     detection (BAD_USER_INPUT), happy-path create args + severity default.
 *   - subscribeToAlertsBatch: auth gate, empty-input validation, severity
 *     validation, missing-location reporting, cartesian expansion, silent
 *     dedupe against existing rows, all-duplicates short-circuit ([]).
 *   - updateAlertSubscription: auth gate, NOT_FOUND, ownership/admin FORBIDDEN
 *     gate, partial-update arg mapping (undefined passthrough), severity guard.
 *   - unsubscribeFromAlerts: auth gate, NOT_FOUND, ownership/admin FORBIDDEN
 *     gate, delete + true return.
 *   - AlertSubscription.user / .location field resolvers: correct delegate call.
 *
 * Deliberately NOT separately tested: the `AlertSubscription` field resolvers
 * are near-trivial passthroughs, but they're cheap and clarify the parent->key
 * mapping, so a couple of light assertions are included rather than skipped.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { subscriptionResolvers } from "../../src/resolvers/subscription.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

/**
 * Build a Context with a stubbed prisma. Pass per-model delegate maps.
 * Only the models a given resolver touches need to be supplied.
 */
function buildContext(
  user: User,
  prisma: {
    userAlertSubscriptions?: Record<string, unknown>;
    locations?: Record<string, unknown>;
    user?: Record<string, unknown>;
  } = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { myAlertSubscriptions, alertSubscriptionsByLocation } = subscriptionResolvers.Query;
const {
  subscribeToAlerts,
  subscribeToAlertsBatch,
  updateAlertSubscription,
  unsubscribeFromAlerts,
} = subscriptionResolvers.Mutation;

const VIEWER = { id: "u1", role: "viewer" };
const ADMIN = { id: "admin1", role: "admin" };

describe("Query.myAlertSubscriptions", () => {
  it("returns the caller's subscriptions, newest first", async () => {
    const rows = [{ id: "s1" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const ctx = buildContext(VIEWER, { userAlertSubscriptions: { findMany } });

    await expect(myAlertSubscriptions(null, {}, ctx)).resolves.toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(myAlertSubscriptions(null, {}, buildContext(null))).rejects.toThrow(
      GraphQLError,
    );
  });
});

describe("Query.alertSubscriptionsByLocation", () => {
  it("returns subscriptions for the location when caller is admin", async () => {
    const rows = [{ id: "s1" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const ctx = buildContext(ADMIN, { userAlertSubscriptions: { findMany } });

    await expect(
      alertSubscriptionsByLocation(null, { locationId: "loc1" }, ctx),
    ).resolves.toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { locationId: "loc1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(VIEWER, { userAlertSubscriptions: { findMany } });
    await expect(
      alertSubscriptionsByLocation(null, { locationId: "loc1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      alertSubscriptionsByLocation(null, { locationId: "loc1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.subscribeToAlerts", () => {
  const baseInput = {
    locationId: "loc1",
    alertType: "FLOOD",
    channel: "EMAIL" as never,
    frequency: "DAILY" as never,
  };

  it("creates a subscription with the caller's id and defaults minSeverity to 1", async () => {
    const created = { id: "s1" };
    const findUnique = vi.fn().mockResolvedValue({ id: "loc1" });
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext(VIEWER, {
      locations: { findUnique },
      userAlertSubscriptions: { findFirst, create },
    });

    await expect(
      subscribeToAlerts(null, { input: { ...baseInput } }, ctx),
    ).resolves.toBe(created);

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        locationId: "loc1",
        alertType: "FLOOD",
        channel: "EMAIL",
        frequency: "DAILY",
        minSeverity: 1,
      },
    });
  });

  it("passes through a valid minSeverity", async () => {
    const create = vi.fn().mockResolvedValue({ id: "s1" });
    const ctx = buildContext(VIEWER, {
      locations: { findUnique: vi.fn().mockResolvedValue({ id: "loc1" }) },
      userAlertSubscriptions: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    await subscribeToAlerts(null, { input: { ...baseInput, minSeverity: 4 } }, ctx);
    expect(create.mock.calls[0][0].data.minSeverity).toBe(4);
  });

  it("throws NOT_FOUND when the location does not exist", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, {
      locations: { findUnique: vi.fn().mockResolvedValue(null) },
      userAlertSubscriptions: { findFirst: vi.fn(), create },
    });
    await expect(
      subscribeToAlerts(null, { input: { ...baseInput } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT on a duplicate subscription", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, {
      locations: { findUnique: vi.fn().mockResolvedValue({ id: "loc1" }) },
      userAlertSubscriptions: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing" }),
        create,
      },
    });
    await expect(
      subscribeToAlerts(null, { input: { ...baseInput } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range minSeverity with BAD_USER_INPUT (and never queries)", async () => {
    const findUnique = vi.fn();
    const create = vi.fn();
    const ctx = buildContext(VIEWER, {
      locations: { findUnique },
      userAlertSubscriptions: { findFirst: vi.fn(), create },
    });
    // validateSeverity runs inside create's data construction, which is after
    // the location + duplicate checks. So we must let those pass.
    findUnique.mockResolvedValue({ id: "loc1" });
    ctx.prisma.userAlertSubscriptions.findFirst = vi.fn().mockResolvedValue(null);

    for (const bad of [0, 6, 2.5, -1]) {
      await expect(
        subscribeToAlerts(null, { input: { ...baseInput, minSeverity: bad } }, ctx),
      ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      subscribeToAlerts(null, { input: { ...baseInput } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.subscribeToAlertsBatch", () => {
  const channel = "EMAIL" as never;
  const frequency = "DAILY" as never;

  it("creates the full cartesian product of locations x alertTypes", async () => {
    // subscriptions.findMany is called twice: existing-check, then read-back.
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([]) // existing subscriptions: none
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]); // read-back
    const createMany = vi.fn().mockResolvedValue({ count: 4 });
    const ctx = buildContext(VIEWER, {
      locations: { findMany: vi.fn().mockResolvedValue([{ id: "loc1" }, { id: "loc2" }]) },
      userAlertSubscriptions: { findMany, createMany },
    });

    const result = await subscribeToAlertsBatch(
      null,
      { input: { locationIds: ["loc1", "loc2"], alertTypes: ["A", "B"], channel, frequency } },
      ctx,
    );

    // createMany received all 4 pairs, with skipDuplicates.
    expect(createMany).toHaveBeenCalledTimes(1);
    const call = createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(4);
    expect(call.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locationId: "loc1", alertType: "A", userId: "u1", minSeverity: 1 }),
        expect.objectContaining({ locationId: "loc1", alertType: "B" }),
        expect.objectContaining({ locationId: "loc2", alertType: "A" }),
        expect.objectContaining({ locationId: "loc2", alertType: "B" }),
      ]),
    );
    expect(result).toHaveLength(4);
  });

  it("de-dupes repeated incoming ids before expansion", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const ctx = buildContext(VIEWER, {
      locations: { findMany: vi.fn().mockResolvedValue([{ id: "loc1" }]) },
      userAlertSubscriptions: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x" }]),
        createMany,
      },
    });
    await subscribeToAlertsBatch(
      null,
      { input: { locationIds: ["loc1", "loc1"], alertTypes: ["A", "A"], channel, frequency } },
      ctx,
    );
    // Only one unique pair survives de-dup.
    expect(createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("skips pairs that already exist and returns [] when all are duplicates", async () => {
    const createMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      locations: { findMany: vi.fn().mockResolvedValue([{ id: "loc1" }]) },
      userAlertSubscriptions: {
        // existing subscriptions cover the only pair
        findMany: vi.fn().mockResolvedValueOnce([{ locationId: "loc1", alertType: "A" }]),
        createMany,
      },
    });
    const result = await subscribeToAlertsBatch(
      null,
      { input: { locationIds: ["loc1"], alertTypes: ["A"], channel, frequency } },
      ctx,
    );
    expect(result).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND listing the missing location ids", async () => {
    const createMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      // only loc1 found; loc2 + loc3 missing
      locations: { findMany: vi.fn().mockResolvedValue([{ id: "loc1" }]) },
      userAlertSubscriptions: { findMany: vi.fn(), createMany },
    });
    await expect(
      subscribeToAlertsBatch(
        null,
        { input: { locationIds: ["loc1", "loc2", "loc3"], alertTypes: ["A"], channel, frequency } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects empty locationIds or empty alertTypes with BAD_USER_INPUT", async () => {
    const ctx = buildContext(VIEWER, {
      locations: { findMany: vi.fn() },
      userAlertSubscriptions: { findMany: vi.fn(), createMany: vi.fn() },
    });
    await expect(
      subscribeToAlertsBatch(
        null,
        { input: { locationIds: [], alertTypes: ["A"], channel, frequency } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      subscribeToAlertsBatch(
        null,
        { input: { locationIds: ["loc1"], alertTypes: [], channel, frequency } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an invalid minSeverity before touching locations", async () => {
    const locFindMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      locations: { findMany: locFindMany },
      userAlertSubscriptions: { findMany: vi.fn(), createMany: vi.fn() },
    });
    await expect(
      subscribeToAlertsBatch(
        null,
        { input: { locationIds: ["loc1"], alertTypes: ["A"], channel, frequency, minSeverity: 9 } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(locFindMany).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      subscribeToAlertsBatch(
        null,
        { input: { locationIds: ["loc1"], alertTypes: ["A"], channel, frequency } },
        buildContext(null),
      ),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.updateAlertSubscription", () => {
  it("updates the caller's own subscription, mapping only provided fields", async () => {
    const update = vi.fn().mockResolvedValue({ id: "s1" });
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "u1" }),
        update,
      },
    });
    await updateAlertSubscription(
      null,
      { id: "s1", input: { active: false, frequency: "WEEKLY" as never } },
      ctx,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: {
        channel: undefined,
        frequency: "WEEKLY",
        active: false,
        minSeverity: undefined,
      },
    });
  });

  it("lets a global admin update another user's subscription", async () => {
    const update = vi.fn().mockResolvedValue({ id: "s1" });
    const ctx = buildContext(ADMIN, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "someone-else" }),
        update,
      },
    });
    await updateAlertSubscription(null, { id: "s1", input: { active: true } }, ctx);
    expect(update).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND when the subscription does not exist", async () => {
    const update = vi.fn();
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: { findUnique: vi.fn().mockResolvedValue(null), update },
    });
    await expect(
      updateAlertSubscription(null, { id: "missing", input: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when a non-admin updates someone else's subscription", async () => {
    const update = vi.fn();
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "other" }),
        update,
      },
    });
    await expect(
      updateAlertSubscription(null, { id: "s1", input: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an invalid minSeverity with BAD_USER_INPUT", async () => {
    const update = vi.fn();
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "u1" }),
        update,
      },
    });
    await expect(
      updateAlertSubscription(null, { id: "s1", input: { minSeverity: 0 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      updateAlertSubscription(null, { id: "s1", input: {} }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.unsubscribeFromAlerts", () => {
  it("deletes the caller's own subscription and returns true", async () => {
    const del = vi.fn().mockResolvedValue({ id: "s1" });
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "u1" }),
        delete: del,
      },
    });
    await expect(unsubscribeFromAlerts(null, { id: "s1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("lets a global admin delete another user's subscription", async () => {
    const del = vi.fn().mockResolvedValue({ id: "s1" });
    const ctx = buildContext(ADMIN, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "other" }),
        delete: del,
      },
    });
    await expect(unsubscribeFromAlerts(null, { id: "s1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND when the subscription does not exist", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: { findUnique: vi.fn().mockResolvedValue(null), delete: del },
    });
    await expect(
      unsubscribeFromAlerts(null, { id: "missing" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when a non-admin deletes someone else's subscription", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userAlertSubscriptions: {
        findUnique: vi.fn().mockResolvedValue({ id: "s1", userId: "other" }),
        delete: del,
      },
    });
    await expect(
      unsubscribeFromAlerts(null, { id: "s1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      unsubscribeFromAlerts(null, { id: "s1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("AlertSubscription field resolvers", () => {
  it("user resolves via prisma.user by parent.userId", () => {
    const userRow = { id: "u1" };
    const findUnique = vi.fn().mockReturnValue(userRow);
    const ctx = buildContext(VIEWER, { user: { findUnique } });
    expect(subscriptionResolvers.AlertSubscription.user({ userId: "u1" }, {}, ctx)).toBe(
      userRow,
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("location resolves via prisma.locations by parent.locationId", () => {
    const locRow = { id: "loc1" };
    const findUnique = vi.fn().mockReturnValue(locRow);
    const ctx = buildContext(VIEWER, { locations: { findUnique } });
    expect(
      subscriptionResolvers.AlertSubscription.location({ locationId: "loc1" }, {}, ctx),
    ).toBe(locRow);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "loc1" } });
  });
});
