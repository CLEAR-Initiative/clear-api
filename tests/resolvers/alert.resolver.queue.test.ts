/**
 * `createAlert` queues alert email; it must not send any.
 *
 * The sibling `alert.resolver.test.ts` cases all stop at "no subscribers", so
 * none of them reach the fan-out's email step. This file covers it, and pins
 * the property the burst incident turned on (clear #1731): raising an alert
 * hands nothing to the email provider, so N alerts can never be N sends. The
 * batching decision belongs to the flush.
 *
 * DB-free, with `await import` so the hoisted `vi.mock` factories can close
 * over the shared spies (the pattern `notification.resolver.test.ts` uses).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendBulk = vi.fn(async () => undefined);

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));
vi.mock("../../src/utils/geo-resolve.js", () => ({
  getLocationIdsWithDescendants: vi.fn(async () => ["loc-1"]),
}));
vi.mock("../../src/utils/env.js", () => ({
  env: { FRONTEND_URL: "http://localhost:3000" },
}));
vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ sendBulk })),
}));
vi.mock("../../src/services/messaging/templates.js", () => ({
  alertNotification: vi.fn(() => ({ subject: "s", textBody: "t", htmlBody: "h" })),
  alertDigest: vi.fn(() => ({ subject: "s", textBody: "t", htmlBody: "h" })),
}));
vi.mock("../../src/utils/alert-email-helpers.js", () => ({
  severityToLabel: vi.fn(() => "CRITICAL"),
  formatCount: vi.fn((n: number) => String(n)),
  resolveEmailLocation: vi.fn(async () => null),
  resolveEventTypeLabel: vi.fn(async () => "Type"),
  fetchEventSignalLocations: vi.fn(async () => ({ ids: [], names: [], overflow: 0 })),
  fetchEventLocalizedText: vi.fn(async () => new Map()),
  normaliseUserLocale: vi.fn((l: string | null) => l ?? "en"),
  localizeLocationNames: vi.fn(async () => new Map()),
  pickLocalizedName: vi.fn(() => null),
}));

const { alertResolvers } = await import("../../src/resolvers/alert.resolver.js");
import type { Context } from "../../src/context.js";

const { createAlert } = alertResolvers.Mutation;
const ADMIN = { id: "admin-1", role: "admin" };

const EVENT = {
  id: "e1",
  title: "Battles in Blue Nile",
  description: "desc",
  types: ["displacement"],
  severity: 5,
  originId: "l1",
  destinationId: null,
  locationId: null,
};

/** Build a context whose subscriber lookup returns `subscriberIds`. */
function contextWith(
  subscriberIds: string[],
  users: Array<{
    id: string;
    name: string;
    email: string | null;
    language: string | null;
    emailNotification: boolean;
  }>,
) {
  const queueCreateMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const client: Record<string, unknown> = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
    decisionRecords: { create: vi.fn().mockResolvedValue({ id: "dr1" }) },
    disasterTypes: { count: vi.fn().mockResolvedValue(1) },
    webhookSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    events: { findUnique: vi.fn().mockResolvedValue(EVENT) },
    alerts: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "al-1", status: "published", createdAt: new Date() }),
    },
    locations: { findMany: vi.fn().mockResolvedValue([{ id: "l1", name: "Blue Nile", level: 1, population: null, ancestorIds: [] }]) },
    userAlertSubscriptions: {
      findMany: vi.fn().mockResolvedValue(subscriberIds.map((userId) => ({ userId }))),
    },
    userAlerts: { createMany: vi.fn(async () => ({ count: subscriberIds.length })) },
    notifications: { createMany: vi.fn(async () => ({ count: subscriberIds.length })) },
    user: { findMany: vi.fn(async () => users) },
    alertEmailQueue: { createMany: queueCreateMany },
  };
  const ctx = {
    prisma: client as Context["prisma"],
    user: ADMIN as Context["user"],
    session: null,
    authMethod: "session",
  } as Context;
  return { ctx, queueCreateMany, client };
}

beforeEach(() => {
  sendBulk.mockClear();
});

describe("createAlert — alert email is queued, never sent", () => {
  it("queues one row per email-enabled subscriber and sends nothing", async () => {
    const { ctx, queueCreateMany } = contextWith(
      ["u-1", "u-2"],
      [
        { id: "u-1", name: "Ana", email: "ana@example.test", language: "en", emailNotification: true },
        { id: "u-2", name: "Bruno", email: "bruno@example.test", language: "fr", emailNotification: true },
      ],
    );

    await createAlert(null, { input: { eventId: "e1", status: "published" as never } }, ctx);

    expect(queueCreateMany).toHaveBeenCalledWith({
      data: [
        { userId: "u-1", alertId: "al-1" },
        { userId: "u-2", alertId: "al-1" },
      ],
      skipDuplicates: true,
    });
    // The whole point: raising an alert talks to no email provider.
    expect(sendBulk).not.toHaveBeenCalled();
  });

  it("leaves out subscribers who have email notifications off", async () => {
    const { ctx, queueCreateMany } = contextWith(
      ["u-1", "u-2"],
      [
        { id: "u-1", name: "Ana", email: "ana@example.test", language: "en", emailNotification: true },
        { id: "u-2", name: "Bruno", email: "bruno@example.test", language: "fr", emailNotification: false },
      ],
    );

    await createAlert(null, { input: { eventId: "e1", status: "published" as never } }, ctx);

    expect(queueCreateMany).toHaveBeenCalledWith({
      data: [{ userId: "u-1", alertId: "al-1" }],
      skipDuplicates: true,
    });
  });

  it("leaves out a subscriber with no email address", async () => {
    const { ctx, queueCreateMany } = contextWith(
      ["u-1"],
      [{ id: "u-1", name: "Ana", email: null, language: "en", emailNotification: true }],
    );

    await createAlert(null, { input: { eventId: "e1", status: "published" as never } }, ctx);

    expect(queueCreateMany).not.toHaveBeenCalled();
  });

  it("still writes the in-app inbox rows, which stay immediate", async () => {
    const { ctx, client } = contextWith(
      ["u-1"],
      [{ id: "u-1", name: "Ana", email: "ana@example.test", language: "en", emailNotification: true }],
    );

    await createAlert(null, { input: { eventId: "e1", status: "published" as never } }, ctx);

    // Only email is batched: userAlerts and the notification are written now.
    expect((client.userAlerts as { createMany: ReturnType<typeof vi.fn> }).createMany).toHaveBeenCalled();
    expect((client.notifications as { createMany: ReturnType<typeof vi.fn> }).createMany).toHaveBeenCalled();
  });
});
