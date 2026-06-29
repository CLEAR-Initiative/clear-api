/**
 * Unit tests for `notification.resolver.ts`.
 *
 * DB-free: `context.prisma.*` delegates are stubbed per-test with `vi.fn()`,
 * and every module that touches an external service is `vi.mock`-ed BEFORE the
 * resolver is imported:
 *   - `../../src/services/messaging/registry.js`  (email provider / SMTP)
 *   - `../../src/services/messaging/templates.js`  (email body builders)
 *   - `../../src/utils/alert-email-helpers.js`     (localization DB helpers)
 * No real Prisma client and no real DB connection are used.
 *
 * Covered branches:
 *   Query.notifications   — auth gate, self-scoped where, optional status filter
 *   Query.notification    — auth gate, self-scoped findFirst
 *   createNotification    — admin-only role gate, persisted fields
 *   createBulkNotifications — admin|analyst gate, fan-out + count return
 *   notifyAlertSubscribers  — role gate, NOT_FOUND, no-subscriber early return,
 *                             subscriber matching (ancestor expansion +
 *                             severity floor), join-table + notification writes,
 *                             email gated on emailNotification
 *   notifyAlertDigest     — role gate, BAD_USER_INPUT on bad frequency,
 *                           no-alerts / no-types / no-subscription / no-match
 *                           early returns, per-alert match logic (type +
 *                           location + severity), digest message preview cap
 *   deleteNotification    — auth gate, ownership NOT_FOUND, happy path
 *   markNotificationRead  — auth gate, ownership NOT_FOUND, sets status READ
 *   markAllNotificationsRead — auth gate, self-scoped updateMany (unread only)
 *
 * Deliberately skipped:
 *   - Notification.user — trivial 1-line prisma passthrough, no logic.
 *   - The per-recipient email localization body-mapping in
 *     notifyAlertSubscribers/notifyAlertDigest — these only stitch together
 *     the (mocked) helper outputs into the (mocked) template; there is no
 *     branching worth asserting beyond "emails are built and sent for users
 *     with emailNotification", which is covered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

const sendBulk = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ sendBulk })),
}));

vi.mock("../../src/services/messaging/templates.js", () => ({
  alertNotification: vi.fn(() => ({
    subject: "subj",
    textBody: "text",
    htmlBody: "html",
  })),
  alertDigest: vi.fn(() => ({
    subject: "subj",
    textBody: "text",
    htmlBody: "html",
  })),
}));

vi.mock("../../src/utils/alert-email-helpers.js", () => ({
  severityToLabel: vi.fn(() => "High"),
  formatCount: vi.fn((n: number) => String(n)),
  resolveEmailLocation: vi.fn(async () => null),
  resolveEventTypeLabel: vi.fn(async () => "Type"),
  fetchEventSignalLocations: vi.fn(async () => ({ ids: [], names: [], overflow: 0 })),
  fetchEventLocalizedText: vi.fn(async () => new Map()),
  normaliseUserLocale: vi.fn((l: string | null) => l ?? "en"),
  localizeLocationNames: vi.fn(async () => new Map()),
  pickLocalizedName: vi.fn(() => null),
}));

const { notificationResolvers } = await import("../../src/resolvers/notification.resolver.js");
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { notifications, notification } = notificationResolvers.Query;
const {
  createNotification,
  createBulkNotifications,
  notifyAlertSubscribers,
  notifyAlertDigest,
  deleteNotification,
  markNotificationRead,
  markAllNotificationsRead,
} = notificationResolvers.Mutation;

beforeEach(() => {
  sendBulk.mockClear();
});

describe("Query.notifications", () => {
  it("returns the caller's notifications, newest first", () => {
    const rows = [{ id: "n1" }];
    const findMany = vi.fn().mockReturnValue(rows);
    const ctx = buildContext({ id: "u1", role: "viewer" }, { notifications: { findMany } });

    expect(notifications(null, {}, ctx)).toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("applies the status filter when supplied", () => {
    const findMany = vi.fn().mockReturnValue([]);
    const ctx = buildContext({ id: "u1", role: "viewer" }, { notifications: { findMany } });

    notifications(null, { status: "READ" }, ctx);
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: "u1", status: "READ" });
  });

  it("throws UNAUTHENTICATED when not logged in", () => {
    expect(() => notifications(null, {}, buildContext(null))).toThrow(GraphQLError);
  });
});

describe("Query.notification", () => {
  it("scopes the lookup to the caller's own id", () => {
    const findFirst = vi.fn().mockReturnValue({ id: "n1" });
    const ctx = buildContext({ id: "u1", role: "viewer" }, { notifications: { findFirst } });

    notification(null, { id: "n1" }, ctx);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "n1", userId: "u1" } });
  });

  it("throws UNAUTHENTICATED when not logged in", () => {
    expect(() => notification(null, { id: "n1" }, buildContext(null))).toThrow(GraphQLError);
  });
});

describe("Mutation.createNotification", () => {
  it("requires admin role", async () => {
    const create = vi.fn();
    const ctx = buildContext({ id: "u1", role: "analyst" }, { notifications: { create } });
    await expect(
      createNotification(null, { input: { userId: "t", message: "m", notificationType: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("persists the supplied fields for an admin caller", async () => {
    const created = { id: "n1" };
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext({ id: "admin1", role: "admin" }, { notifications: { create } });

    const result = await createNotification(
      null,
      {
        input: {
          userId: "target",
          message: "hi",
          notificationType: "system",
          actionUrl: "/x",
          actionText: "Go",
        },
      },
      ctx,
    );
    expect(result).toBe(created);
    expect(create.mock.calls[0][0].data).toEqual({
      userId: "target",
      message: "hi",
      notificationType: "system",
      actionUrl: "/x",
      actionText: "Go",
    });
  });
});

describe("Mutation.createBulkNotifications", () => {
  it("rejects a viewer with FORBIDDEN", async () => {
    const createMany = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, { notifications: { createMany } });
    await expect(
      createBulkNotifications(
        null,
        { input: { userIds: ["a"], message: "m", notificationType: "x" } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("fans out one row per user and returns the created count", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const ctx = buildContext({ id: "an1", role: "analyst" }, { notifications: { createMany } });

    const count = await createBulkNotifications(
      null,
      { input: { userIds: ["a", "b"], message: "m", notificationType: "x" } },
      ctx,
    );
    expect(count).toBe(2);
    const data = createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(2);
    expect(data.map((d: { userId: string }) => d.userId)).toEqual(["a", "b"]);
    expect(data[0].message).toBe("m");
  });
});

describe("Mutation.notifyAlertSubscribers", () => {
  it("requires admin or analyst role", async () => {
    const ctx = buildContext({ id: "u1", role: "viewer" }, {});
    await expect(
      notifyAlertSubscribers(null, { input: { alertId: "a1" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the alert does not exist", async () => {
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      { alerts: { findUnique: vi.fn().mockResolvedValue(null) } },
    );
    await expect(
      notifyAlertSubscribers(null, { input: { alertId: "missing" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("returns 0 without writing when no subscribers match", async () => {
    const notificationsCreateMany = vi.fn();
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: {
          findUnique: vi.fn().mockResolvedValue({
            id: "a1",
            event: {
              id: "e1",
              types: ["FLOOD"],
              originId: "loc1",
              destinationId: null,
              locationId: null,
              severity: 3,
              title: "t",
              description: "d",
              generalLocation: null,
              originLocation: null,
            },
          }),
        },
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: [] }]) },
        // No matching subscriptions.
        userAlertSubscriptions: { findMany: vi.fn().mockResolvedValue([]) },
        notifications: { createMany: notificationsCreateMany },
      },
    );

    const result = await notifyAlertSubscribers(null, { input: { alertId: "a1" } }, ctx);
    expect(result).toBe(0);
    expect(notificationsCreateMany).not.toHaveBeenCalled();
  });

  it("expands locations to ancestors and filters subscriptions by severity floor", async () => {
    const subFindMany = vi.fn().mockResolvedValue([{ userId: "u-sub" }]);
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: {
          findUnique: vi.fn().mockResolvedValue({
            id: "a1",
            event: {
              id: "e1",
              types: ["FLOOD"],
              originId: "district1",
              destinationId: null,
              locationId: null,
              severity: 2,
              title: "Flood",
              description: "desc",
              populationAffected: null,
              generalLocation: null,
              originLocation: null,
            },
          }),
        },
        // district1's ancestor chain adds country1.
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: ["country1"] }]) },
        userAlertSubscriptions: { findMany: subFindMany },
        userAlerts: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        notifications: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        // No recipients with email -> no email branch.
        user: { findMany: vi.fn().mockResolvedValue([{ id: "u-sub", name: "S", email: "s@x.com", language: null, emailNotification: false }]) },
      },
    );

    const result = await notifyAlertSubscribers(null, { input: { alertId: "a1" } }, ctx);
    expect(result).toBe(1);

    const where = subFindMany.mock.calls[0][0].where;
    expect(where.frequency).toBe("immediately");
    expect(where.active).toBe(true);
    expect(where.alertType).toEqual({ in: ["FLOOD"] });
    // Ancestor expansion: both the direct location and its ancestor are queried.
    expect(where.locationId.in.sort()).toEqual(["country1", "district1"]);
    // severity 2 -> subscriptions whose minSeverity <= 2 match.
    expect(where.minSeverity).toEqual({ lte: 2 });

    // Email is gated off because the only recipient has emailNotification:false.
    expect(sendBulk).not.toHaveBeenCalled();
  });

  it("sends email only to recipients with emailNotification enabled", async () => {
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: {
          findUnique: vi.fn().mockResolvedValue({
            id: "a1",
            event: {
              id: "e1",
              types: ["FLOOD"],
              originId: "loc1",
              destinationId: null,
              locationId: null,
              severity: 1,
              title: "Flood",
              description: "desc",
              populationAffected: 100,
              generalLocation: null,
              originLocation: null,
            },
          }),
        },
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: [] }]) },
        userAlertSubscriptions: {
          findMany: vi.fn().mockResolvedValue([{ userId: "u-on" }, { userId: "u-off" }]),
        },
        userAlerts: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        notifications: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        user: {
          findMany: vi.fn().mockResolvedValue([
            { id: "u-on", name: "On", email: "on@x.com", language: null, emailNotification: true },
            { id: "u-off", name: "Off", email: "off@x.com", language: null, emailNotification: false },
          ]),
        },
      },
    );

    const result = await notifyAlertSubscribers(null, { input: { alertId: "a1" } }, ctx);
    expect(result).toBe(2);
    // Allow the fire-and-forget email promise to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(sendBulk).toHaveBeenCalledTimes(1);
    const emails = sendBulk.mock.calls[0][0];
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("on@x.com");
  });
});

describe("Mutation.notifyAlertDigest", () => {
  const goodInput = { alertIds: ["a1"], frequency: "daily" as const };

  it("requires admin or analyst role", async () => {
    const ctx = buildContext({ id: "u1", role: "viewer" }, {});
    await expect(
      notifyAlertDigest(null, { input: goodInput }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects an invalid frequency with BAD_USER_INPUT", async () => {
    const ctx = buildContext({ id: "an1", role: "analyst" }, {});
    await expect(
      notifyAlertDigest(
        null,
        { input: { alertIds: ["a1"], frequency: "hourly" as unknown as "daily" } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("returns 0 when no alerts are found", async () => {
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      { alerts: { findMany: vi.fn().mockResolvedValue([]) } },
    );
    expect(await notifyAlertDigest(null, { input: goodInput }, ctx)).toBe(0);
  });

  it("returns 0 when no subscriptions match", async () => {
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "a1",
              event: { id: "e1", types: ["FLOOD"], originId: "loc1", destinationId: null, locationId: null, severity: 3, title: "t", description: "d" },
            },
          ]),
        },
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: [] }]) },
        userAlertSubscriptions: { findMany: vi.fn().mockResolvedValue([]) },
      },
    );
    expect(await notifyAlertDigest(null, { input: goodInput }, ctx)).toBe(0);
  });

  it("matches a subscription on type+location+severity and writes a digest", async () => {
    const notifCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "a1",
              event: { id: "e1", types: ["FLOOD"], originId: "district1", destinationId: null, locationId: null, severity: 5, title: "Big Flood", description: "d" },
            },
          ]),
        },
        // district1 expands to include country1.
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: ["country1"] }]) },
        userAlertSubscriptions: {
          findMany: vi.fn().mockResolvedValue([
            // Matches: type FLOOD, country1 in expanded set, minSeverity 3 <= 5.
            { userId: "u-match", alertType: "FLOOD", locationId: "country1", minSeverity: 3 },
            // No match: severity floor too high (7 > 5).
            { userId: "u-toohigh", alertType: "FLOOD", locationId: "district1", minSeverity: 7 },
            // No match: wrong type.
            { userId: "u-wrongtype", alertType: "FIRE", locationId: "district1", minSeverity: 1 },
          ]),
        },
        userAlerts: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        notifications: { createMany: notifCreateMany },
        user: { findMany: vi.fn().mockResolvedValue([]) },
      },
    );

    const result = await notifyAlertDigest(null, { input: goodInput }, ctx);
    expect(result).toBe(1);

    const rows = notifCreateMany.mock.calls[0][0].data;
    // Only the matching user gets a digest notification.
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("u-match");
    expect(rows[0].notificationType).toBe("alert_digest");
    expect(rows[0].message).toContain("Daily digest (1)");
    expect(rows[0].message).toContain("Big Flood");
  });

  it("caps the digest preview at 3 titles and appends an overflow suffix", async () => {
    const notifCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const alertIds = ["a1", "a2", "a3", "a4"];
    const events = alertIds.map((id, i) => ({
      id,
      event: {
        id: `e${i}`,
        types: ["FLOOD"],
        originId: "loc1",
        destinationId: null,
        locationId: null,
        severity: 5,
        title: `Alert ${i}`,
        description: "d",
      },
    }));
    const ctx = buildContext(
      { id: "an1", role: "analyst" },
      {
        alerts: { findMany: vi.fn().mockResolvedValue(events) },
        locations: { findMany: vi.fn().mockResolvedValue([{ ancestorIds: [] }]) },
        userAlertSubscriptions: {
          findMany: vi.fn().mockResolvedValue([
            { userId: "u1", alertType: "FLOOD", locationId: "loc1", minSeverity: 1 },
          ]),
        },
        userAlerts: { createMany: vi.fn().mockResolvedValue({ count: 4 }) },
        notifications: { createMany: notifCreateMany },
        user: { findMany: vi.fn().mockResolvedValue([]) },
      },
    );

    await notifyAlertDigest(null, { input: { alertIds, frequency: "weekly" } }, ctx);
    const msg = notifCreateMany.mock.calls[0][0].data[0].message;
    expect(msg).toContain("Weekly digest (4)");
    expect(msg).toContain("+1 more");
  });
});

describe("Mutation.deleteNotification", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      deleteNotification(null, { id: "n1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND for someone else's notification", async () => {
    const del = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { notifications: { findUnique: vi.fn().mockResolvedValue({ id: "n1", userId: "other" }), delete: del } },
    );
    await expect(deleteNotification(null, { id: "n1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the notification is missing", async () => {
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { notifications: { findUnique: vi.fn().mockResolvedValue(null), delete: vi.fn() } },
    );
    await expect(deleteNotification(null, { id: "missing" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("deletes the caller's own notification", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { notifications: { findUnique: vi.fn().mockResolvedValue({ id: "n1", userId: "u1" }), delete: del } },
    );
    expect(await deleteNotification(null, { id: "n1" }, ctx)).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "n1" } });
  });
});

describe("Mutation.markNotificationRead", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      markNotificationRead(null, { id: "n1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND for someone else's notification", async () => {
    const update = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { notifications: { findUnique: vi.fn().mockResolvedValue({ id: "n1", userId: "other" }), update } },
    );
    await expect(markNotificationRead(null, { id: "n1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("sets status to READ on the caller's own notification", async () => {
    const updated = { id: "n1", status: "READ" };
    const update = vi.fn().mockResolvedValue(updated);
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { notifications: { findUnique: vi.fn().mockResolvedValue({ id: "n1", userId: "u1" }), update } },
    );
    expect(await markNotificationRead(null, { id: "n1" }, ctx)).toBe(updated);
    expect(update).toHaveBeenCalledWith({ where: { id: "n1" }, data: { status: "READ" } });
  });
});

describe("Mutation.markAllNotificationsRead", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      markAllNotificationsRead(null, {}, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("marks only the caller's unread notifications as READ", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const ctx = buildContext({ id: "u1", role: "viewer" }, { notifications: { updateMany } });

    expect(await markAllNotificationsRead(null, {}, ctx)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", status: { not: "READ" } },
      data: { status: "READ" },
    });
  });
});
