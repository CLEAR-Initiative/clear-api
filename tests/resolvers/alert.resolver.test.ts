/**
 * Unit tests for `alert.resolver.ts`.
 *
 * DB-FREE: no real Prisma client and no database connection. `context.prisma`
 * is a per-test stub exposing only the delegates each resolver actually calls.
 * Every imported module that reaches outside the resolver — the messaging
 * email provider/templates, the activity-log writer, the env config, and the
 * geo/location-scope helpers — is `vi.mock()`ed BEFORE the resolver is
 * imported, so the file runs in CI with no DB, no Redis, and no SMTP.
 *
 * Covered (branches with real logic):
 *   Query.alerts          — auth gate; status filter; includeDummy default;
 *                           teamId branch wiring the team location filter.
 *   Query.alertsByLocation — auth gate; descendant expansion → OR filter.
 *   Query.alert           — auth gate.
 *   Mutation.createAlert  — requireRole(admin/analyst); NOT_FOUND on missing
 *                           event; default status "draft"; idempotent return
 *                           of an existing alert; status update on an existing
 *                           alert; no-op fan-out (no subscriber side effects)
 *                           when the alert already existed.
 *   Mutation.updateAlert  — requireRole; NOT_FOUND; status passthrough.
 *   Mutation.deleteAlert  — requireRole(admin); NOT_FOUND; delete + return.
 *   Mutation.archiveStaleAlerts — requireRole(admin); default 14 days;
 *                           BAD_USER_INPUT on non-positive days; cutoff math.
 *   Alert.event           — preloaded fast-path vs lazy findUnique.
 *
 * Deliberately skipped (pure passthroughs, no branching to assert):
 *   Alert.userAlerts, UserAlert.user, UserAlert.alert — single findMany/
 *   findUnique with no logic. The first-time createAlert subscriber fan-out
 *   (in-app + email) is an integration concern (it drives the mocked email
 *   provider through many helper calls); the unit-testable contract here is
 *   "existing alerts skip the fan-out entirely", which is covered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

// Mock everything the resolver imports that touches external services or the
// DB, BEFORE importing the resolver so these bindings are the ones it picks up.
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));
vi.mock("../../src/utils/geo-resolve.js", () => ({
  getLocationIdsWithDescendants: vi.fn(async () => ["loc-1", "loc-2"]),
}));
vi.mock("../../src/utils/location-scope.js", () => ({
  buildEventLocationFilterForTeam: vi.fn(async () => ({ originId: { in: ["loc-team"] } })),
}));
vi.mock("../../src/utils/env.js", () => ({
  env: { FRONTEND_URL: "http://localhost:3000" },
}));
vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ sendBulk: vi.fn(async () => undefined) })),
}));
vi.mock("../../src/services/messaging/templates.js", () => ({
  alertNotification: vi.fn(() => ({ subject: "s", textBody: "t", htmlBody: "h" })),
}));

import { alertResolvers } from "../../src/resolvers/alert.resolver.js";
import { logActivity } from "../../src/utils/activity-log.js";
import { getLocationIdsWithDescendants } from "../../src/utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../../src/utils/location-scope.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

/**
 * Minimal Context: only `prisma` (the supplied delegate stubs) plus the auth
 * fields the guards read. Cast as the sibling tests do.
 */
function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { alerts, alertsByLocation, alert } = alertResolvers.Query;
const { createAlert, updateAlert, deleteAlert, archiveStaleAlerts } =
  alertResolvers.Mutation;

const ADMIN = { id: "admin1", role: "admin" };
const ANALYST = { id: "an1", role: "analyst" };
const VIEWER = { id: "v1", role: "viewer" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Query.alerts", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(alerts(null, {}, buildContext(null))).rejects.toThrow(GraphQLError);
  });

  it("returns the global feed (no status, isDummy excluded) when no args", async () => {
    const rows = [{ id: 1 }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const ctx = buildContext(VIEWER, { alerts: { findMany } });

    await expect(alerts(null, {}, ctx)).resolves.toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { event: { isDummy: false } },
    });
    // No teamId → team location filter is never consulted.
    expect(buildEventLocationFilterForTeam).not.toHaveBeenCalled();
  });

  it("applies the status filter and includeDummy=true relaxes the dummy gate", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { alerts: { findMany } });

    await alerts(null, { status: "active" as never, includeDummy: true }, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "active", event: {} },
    });
  });

  it("merges the team location filter into the event filter when teamId is given", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { alerts: { findMany } });

    await alerts(null, { teamId: "t1", status: "draft" as never }, ctx);

    expect(buildEventLocationFilterForTeam).toHaveBeenCalledWith(ctx.prisma, "t1");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "draft",
        event: { isDummy: false, originId: { in: ["loc-team"] } },
      },
    });
  });

  it("tolerates a null team filter (team has no location scope)", async () => {
    (buildEventLocationFilterForTeam as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { alerts: { findMany } });

    await alerts(null, { teamId: "t1" }, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { event: { isDummy: false } },
    });
  });
});

describe("Query.alertsByLocation", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      alertsByLocation(null, { locationId: "x" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("expands descendants and matches any of origin/destination/location", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { alerts: { findMany } });

    await alertsByLocation(null, { locationId: "root", status: "active" as never }, ctx);

    expect(getLocationIdsWithDescendants).toHaveBeenCalledWith(ctx.prisma, "root");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "active",
        event: {
          OR: [
            { originId: { in: ["loc-1", "loc-2"] } },
            { destinationId: { in: ["loc-1", "loc-2"] } },
            { locationId: { in: ["loc-1", "loc-2"] } },
          ],
        },
      },
    });
  });
});

describe("Query.alert", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(alert(null, { id: "1" }, buildContext(null))).rejects.toThrow(GraphQLError);
  });

  it("fetches the alert by id once authenticated", async () => {
    const row = { id: 1 };
    const findUnique = vi.fn().mockResolvedValue(row);
    const ctx = buildContext(VIEWER, { alerts: { findUnique } });
    await expect(alert(null, { id: "1" }, ctx)).resolves.toBe(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "1" } });
  });
});

describe("Mutation.createAlert", () => {
  it("throws FORBIDDEN for a viewer (requireRole admin/analyst)", async () => {
    const ctx = buildContext(VIEWER, {});
    await expect(
      createAlert(null, { input: { eventId: "e1" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      createAlert(null, { input: { eventId: "e1" } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND when the event does not exist", async () => {
    const create = vi.fn();
    const ctx = buildContext(ANALYST, {
      events: { findUnique: vi.fn().mockResolvedValue(null) },
      alerts: { create },
    });
    await expect(
      createAlert(null, { input: { eventId: "missing" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new alert with default status 'draft' when none exists", async () => {
    // No locations / no types on the event → fan-out short-circuits, so the
    // create path is unit-testable without exercising the subscriber loop.
    const event = { id: "e1", types: [], severity: 2, originId: null, destinationId: null, locationId: null };
    const created = { id: 99, status: "draft" };
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext(ANALYST, {
      events: { findUnique: vi.fn().mockResolvedValue(event) },
      alerts: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    });

    const result = await createAlert(null, { input: { eventId: "e1" } }, ctx);
    expect(result).toBe(created);
    expect(create).toHaveBeenCalledWith({ data: { eventId: "e1", status: "draft" } });
    // First-time creation records exactly one activity entry.
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect((logActivity as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      userId: ANALYST.id,
      action: "alert.create",
      resourceType: "alert",
      resourceId: 99,
    });
  });

  it("honours an explicit status on a brand-new alert", async () => {
    const event = { id: "e1", types: [], severity: 1, originId: null, destinationId: null, locationId: null };
    const create = vi.fn().mockResolvedValue({ id: 1, status: "active" });
    const ctx = buildContext(ADMIN, {
      events: { findUnique: vi.fn().mockResolvedValue(event) },
      alerts: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    await createAlert(null, { input: { eventId: "e1", status: "active" as never } }, ctx);
    expect(create).toHaveBeenCalledWith({ data: { eventId: "e1", status: "active" } });
  });

  it("is idempotent: returns the existing alert and skips fan-out + activity log when status matches", async () => {
    const event = { id: "e1", types: ["displacement"], severity: 5, originId: "l1", destinationId: null, locationId: null };
    const existing = { id: 7, status: "draft", eventId: "e1" };
    const create = vi.fn();
    const update = vi.fn();
    const subFind = vi.fn();
    const ctx = buildContext(ANALYST, {
      events: { findUnique: vi.fn().mockResolvedValue(event) },
      alerts: {
        findFirst: vi.fn().mockResolvedValue(existing),
        create,
        update,
      },
      // present so an accidental fan-out would be observable
      userAlertSubscriptions: { findMany: subFind },
    });

    const result = await createAlert(null, { input: { eventId: "e1" } }, ctx);
    expect(result).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // existing alert → no new activity entry, no subscriber fan-out
    expect(logActivity).not.toHaveBeenCalled();
    expect(subFind).not.toHaveBeenCalled();
  });

  it("updates the existing alert's status when the caller requests a different one, then skips fan-out", async () => {
    const event = { id: "e1", types: ["displacement"], severity: 5, originId: "l1", destinationId: null, locationId: null };
    const existing = { id: 7, status: "draft", eventId: "e1" };
    const updated = { id: 7, status: "active" };
    const update = vi.fn().mockResolvedValue(updated);
    const subFind = vi.fn();
    const ctx = buildContext(ANALYST, {
      events: { findUnique: vi.fn().mockResolvedValue(event) },
      alerts: {
        findFirst: vi.fn().mockResolvedValue(existing),
        update,
      },
      userAlertSubscriptions: { findMany: subFind },
    });

    const result = await createAlert(null, { input: { eventId: "e1", status: "active" as never } }, ctx);
    expect(result).toBe(updated);
    expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: "active" } });
    // still an "existing" alert → no fan-out, no activity log
    expect(logActivity).not.toHaveBeenCalled();
    expect(subFind).not.toHaveBeenCalled();
  });
});

describe("Mutation.updateAlert", () => {
  it("throws FORBIDDEN for a viewer", async () => {
    await expect(
      updateAlert(null, { id: "1", input: { status: "active" as never } }, buildContext(VIEWER, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the alert is missing", async () => {
    const update = vi.fn();
    const ctx = buildContext(ANALYST, {
      alerts: { findUnique: vi.fn().mockResolvedValue(null), update },
    });
    await expect(
      updateAlert(null, { id: "missing", input: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the status (and passes undefined when status is omitted)", async () => {
    const updated = { id: 1, status: "active" };
    const update = vi.fn().mockResolvedValue(updated);
    const ctx = buildContext(ADMIN, {
      alerts: { findUnique: vi.fn().mockResolvedValue({ id: 1 }), update },
    });

    await updateAlert(null, { id: "1", input: { status: "active" as never } }, ctx);
    expect(update).toHaveBeenCalledWith({ where: { id: "1" }, data: { status: "active" } });

    await updateAlert(null, { id: "1", input: {} }, ctx);
    expect(update).toHaveBeenLastCalledWith({ where: { id: "1" }, data: { status: undefined } });
  });
});

describe("Mutation.deleteAlert", () => {
  it("throws FORBIDDEN for an analyst (admin-only)", async () => {
    await expect(
      deleteAlert(null, { id: "1" }, buildContext(ANALYST, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the alert is missing", async () => {
    const del = vi.fn();
    const ctx = buildContext(ADMIN, {
      alerts: { findUnique: vi.fn().mockResolvedValue(null), delete: del },
    });
    await expect(deleteAlert(null, { id: "x" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the alert and returns true", async () => {
    const del = vi.fn().mockResolvedValue({ id: 1 });
    const ctx = buildContext(ADMIN, {
      alerts: { findUnique: vi.fn().mockResolvedValue({ id: 1 }), delete: del },
    });
    await expect(deleteAlert(null, { id: "1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "1" } });
  });
});

describe("Mutation.archiveStaleAlerts", () => {
  it("throws FORBIDDEN for an analyst (admin-only)", async () => {
    await expect(
      archiveStaleAlerts(null, {}, buildContext(ANALYST, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects non-positive / non-finite olderThanDays with BAD_USER_INPUT", async () => {
    const updateMany = vi.fn();
    const ctx = buildContext(ADMIN, { alerts: { updateMany } });
    for (const bad of [0, -1, Number.NaN]) {
      await expect(
        archiveStaleAlerts(null, { olderThanDays: bad }, ctx),
      ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("defaults to 14 days, only touches non-archived alerts, and returns the count", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const ctx = buildContext(ADMIN, { alerts: { updateMany } });
    const before = Date.now();

    const result = await archiveStaleAlerts(null, {}, ctx);
    expect(result).toEqual({ alertsArchived: 3 });

    const arg = updateMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({ not: "archived" });
    expect(arg.data).toEqual({ status: "archived" });
    // cutoff ≈ now - 14 days
    const cutoff: Date = arg.where.event.lastSignalCreatedAt.lt;
    expect(cutoff).toBeInstanceOf(Date);
    const expected = before - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });

  it("honours a custom olderThanDays in the cutoff math", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const ctx = buildContext(ADMIN, { alerts: { updateMany } });
    const before = Date.now();
    await archiveStaleAlerts(null, { olderThanDays: 1 }, ctx);
    const cutoff: Date = updateMany.mock.calls[0][0].where.event.lastSignalCreatedAt.lt;
    const expected = before - 1 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });
});

describe("Alert.event field resolver", () => {
  const eventField = alertResolvers.Alert.event;

  it("returns the preloaded event without hitting prisma", () => {
    const preloaded = { id: "e1", title: "x" };
    const findUnique = vi.fn();
    const ctx = buildContext(VIEWER, { events: { findUnique } });
    const result = eventField({ eventId: "e1", event: preloaded }, undefined, ctx);
    expect(result).toBe(preloaded);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("lazily fetches the event by id when not preloaded", () => {
    const row = { id: "e1" };
    const findUnique = vi.fn().mockReturnValue(row);
    const ctx = buildContext(VIEWER, { events: { findUnique } });
    const result = eventField({ eventId: "e1" }, undefined, ctx);
    expect(result).toBe(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "e1" } });
  });
});

describe("Alert.representativePoint — delegates to the loader by eventId", () => {
  const rp = alertResolvers.Alert.representativePoint;

  function ctxWithLoader(load: ReturnType<typeof vi.fn>) {
    return { representativePointLoader: { load } } as unknown as Context;
  }

  it("returns the eager-loaded value without touching the loader", async () => {
    const load = vi.fn();
    const preset = { id: "loc-pre" };
    expect(await rp({ eventId: "e1", representativePoint: preset }, {}, ctxWithLoader(load)))
      .toBe(preset);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads by the alert's eventId (same point as the event)", async () => {
    const loc = { id: "loc-first" };
    const load = vi.fn().mockResolvedValue(loc);
    expect(await rp({ eventId: "e1" }, {}, ctxWithLoader(load))).toBe(loc);
    expect(load).toHaveBeenCalledWith("e1");
  });
});
