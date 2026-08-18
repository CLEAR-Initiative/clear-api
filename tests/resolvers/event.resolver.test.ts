/**
 * Unit tests for `event.resolver.ts`.
 *
 * DB-free: `context.prisma.*` delegates are stubbed per-test with `vi.fn()`
 * and never touch a real database. Every imported module that reaches an
 * external service is mocked BEFORE the resolver is imported:
 *   - `../../src/utils/geo-resolve.js`     (PostGIS / location resolution)
 *   - `../../src/utils/location-scope.js`  (team location filter builder)
 *   - `../../src/utils/activity-log.js`    (audit-log writes)
 *   - `../../src/services/translation-queue.js` (durable translation enqueue)
 *   - `../../src/services/messaging/registry.js` + `.../templates.js` (email)
 *   - `../../src/utils/alert-email-helpers.js` (localization helpers)
 *
 * Covered (logic worth testing):
 *   Query.events          — auth gate, includeDummy filter, teamId vs global
 *                           branch (team filter merge), locale include omission.
 *   Query.eventsByLocation— auth gate, descendant expansion + OR filter shape.
 *   Query.event           — auth gate, findUnique by id.
 *   Mutation.createEvent  — requireRole gate; lat/lng → point location branch;
 *                           signalIds → single/multi point resolution branch;
 *                           BigInt population conversion + undefined defaults;
 *                           signalEvents dedupe; activity log fire.
 *   Mutation.updateEvent  — requireRole gate, NOT_FOUND, additive/idempotent
 *                           signal linking (only unlinked ids created).
 *   Mutation.deleteEvent  — admin-only gate, NOT_FOUND, delete call.
 *   Mutation.escalateEvent— requireRole gate, NOT_FOUND, skip-alert-when-exists,
 *                           idempotent escalation upsert.
 *   Event field resolvers — title/description locale overlay + lazy-enqueue;
 *                           signals fast path + selection probe; *Location fast
 *                           path / null / findUnique; descriptionSignals +
 *                           BigInt population string coercion.
 *
 * Deliberately NOT unit-tested (raw SQL / passthrough with no branchable
 * logic): the `$queryRaw` PostGIS point fetch inside createEvent (exercised
 * only indirectly via the mocked multi-point path), and the trivial
 * `prisma.x.findMany({ where: { eventId } })` passthroughs
 * (Event.alerts non-fast-path, feedbacks, comments, escalations,
 * EventEscalation.user/event) — these carry no logic beyond a single
 * delegate call. The full email fan-out body of escalateEvent is covered
 * only at the branch level (alert created / not created); its localization
 * internals live in the separately-tested alert-email-helpers and are
 * mocked here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";
import type { GraphQLResolveInfo } from "graphql";

// --- Mock external-service modules BEFORE importing the resolver. ---
vi.mock("../../src/utils/geo-resolve.js", () => ({
  createPointLocation: vi.fn(),
  resolvePointsToCommonAncestor: vi.fn(),
  getLocationIdsWithDescendants: vi.fn(),
}));
vi.mock("../../src/utils/location-scope.js", () => ({
  buildEventLocationFilterForTeam: vi.fn(),
}));
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn(),
}));
vi.mock("../../src/services/translation-queue.js", () => ({
  enqueueTranslationDurable: vi.fn(),
}));
vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ sendBulk: vi.fn() })),
}));
vi.mock("../../src/services/messaging/templates.js", () => ({
  alertNotification: vi.fn(() => ({ subject: "s", textBody: "t", htmlBody: "h" })),
}));
vi.mock("../../src/utils/alert-email-helpers.js", () => ({
  severityToLabel: vi.fn(() => "High"),
  formatCount: vi.fn(() => "100"),
  resolveEmailLocation: vi.fn(async () => null),
  resolveEventTypeLabel: vi.fn(async () => "Flood"),
  fetchEventSignalLocations: vi.fn(async () => ({ ids: [], names: [], overflow: 0 })),
  fetchEventLocalizedText: vi.fn(async () => new Map()),
  normaliseUserLocale: vi.fn((l: string | null) => l ?? "en"),
  localizeLocationNames: vi.fn(async () => new Map()),
  pickLocalizedName: vi.fn(() => null),
}));

import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";
import {
  createPointLocation,
  resolvePointsToCommonAncestor,
  getLocationIdsWithDescendants,
} from "../../src/utils/geo-resolve.js";
import { buildEventLocationFilterForTeam } from "../../src/utils/location-scope.js";
import { logActivity } from "../../src/utils/activity-log.js";
import { enqueueTranslationDurable } from "../../src/services/translation-queue.js";

type User = { id: string; role: string } | null;

function buildContext(
  user: User,
  prisma: Record<string, unknown> = {},
  locale: "en" | "ar" | "fr" = "en",
  translationLoader: { load: ReturnType<typeof vi.fn> } = { load: vi.fn() },
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale,
    translationLoader,
  } as unknown as Context;
}

const ADMIN = { id: "admin1", role: "admin" };
const ANALYST = { id: "an1", role: "analyst" };
const VIEWER = { id: "v1", role: "viewer" };

const { events, eventsByLocation, event } = eventResolvers.Query;
const { createEvent, updateEvent, deleteEvent, escalateEvent } = eventResolvers.Mutation;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Query.events
// ---------------------------------------------------------------------------
describe("Query.events", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(events(null, {}, buildContext(null))).rejects.toThrow(GraphQLError);
  });

  it("returns the global feed with isDummy:false by default (no teamId)", async () => {
    const rows = [{ id: "e1" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const ctx = buildContext(VIEWER, { events: { findMany } });
    await expect(events(null, {}, ctx)).resolves.toBe(rows);
    expect(findMany).toHaveBeenCalledWith({ where: { isDummy: false } });
    expect(buildEventLocationFilterForTeam).not.toHaveBeenCalled();
  });

  it("includes dummy events when includeDummy is true", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { events: { findMany } });
    await events(null, { includeDummy: true }, ctx);
    expect(findMany).toHaveBeenCalledWith({ where: {} });
  });

  it("merges the team location filter with the dummy filter when teamId given", async () => {
    const teamFilter = { OR: [{ locationId: { in: ["L1"] } }] };
    (buildEventLocationFilterForTeam as ReturnType<typeof vi.fn>).mockResolvedValue(teamFilter);
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { events: { findMany } });
    await events(null, { teamId: "t1" }, ctx);
    expect(buildEventLocationFilterForTeam).toHaveBeenCalledWith(ctx.prisma, "t1");
    expect(findMany).toHaveBeenCalledWith({ where: { ...teamFilter, isDummy: false } });
  });

  it("adds the translations include for a non-default locale", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { events: { findMany } }, "ar");
    await events(null, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({
      where: { isDummy: false },
      include: { translations: { where: { locale: "ar" } } },
    });
  });
});

// ---------------------------------------------------------------------------
// Query.eventsByLocation
// ---------------------------------------------------------------------------
describe("Query.eventsByLocation", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      eventsByLocation(null, { locationId: "L1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("expands to descendants and queries the origin/destination/location OR filter", async () => {
    (getLocationIdsWithDescendants as ReturnType<typeof vi.fn>).mockResolvedValue(["L1", "L2"]);
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { events: { findMany } });
    await eventsByLocation(null, { locationId: "L1" }, ctx);
    expect(getLocationIdsWithDescendants).toHaveBeenCalledWith(ctx.prisma, "L1");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { originId: { in: ["L1", "L2"] } },
          { destinationId: { in: ["L1", "L2"] } },
          { locationId: { in: ["L1", "L2"] } },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Query.event
// ---------------------------------------------------------------------------
describe("Query.event", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(event(null, { id: "e1" }, buildContext(null))).rejects.toThrow(GraphQLError);
  });

  it("fetches a single event by id without include for default locale", async () => {
    const row = { id: "e1" };
    const findUnique = vi.fn().mockResolvedValue(row);
    const ctx = buildContext(VIEWER, { events: { findUnique } });
    await expect(event(null, { id: "e1" }, ctx)).resolves.toBe(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "e1" } });
  });
});

// ---------------------------------------------------------------------------
// Mutation.createEvent
// ---------------------------------------------------------------------------
function baseCreateInput(over: Record<string, unknown> = {}) {
  return {
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-01-02T00:00:00.000Z",
    firstSignalCreatedAt: "2026-01-01T00:00:00.000Z",
    lastSignalCreatedAt: "2026-01-01T00:00:00.000Z",
    types: ["flood"],
    rank: 1,
    signalIds: [],
    ...over,
  };
}

describe("Mutation.createEvent", () => {
  it("throws FORBIDDEN for a viewer", async () => {
    await expect(
      createEvent(null, { input: baseCreateInput() as never }, buildContext(VIEWER)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      createEvent(null, { input: baseCreateInput() as never }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("creates a point location from lat/lng when no explicit location given", async () => {
    (createPointLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "point-loc" });
    const create = vi.fn().mockResolvedValue({ id: "e1", title: "T", types: ["flood"], severity: null });
    const ctx = buildContext(ANALYST, { events: { create }, signalEvents: { createMany: vi.fn() } });
    await createEvent(
      null,
      { input: baseCreateInput({ lat: 1.5, lng: 2.5 }) as never },
      ctx,
    );
    expect(createPointLocation).toHaveBeenCalledWith(ctx.prisma, 1.5, 2.5);
    expect(create.mock.calls[0][0].data.locationId).toBe("point-loc");
  });

  it("reuses the single signal location when signals resolve to one point", async () => {
    const signalsFindMany = vi.fn().mockResolvedValue([{ locationId: "S1", originId: null, destinationId: null }]);
    const queryRaw = vi.fn().mockResolvedValue([{ lat: 1, lng: 2 }]); // exactly one point
    const create = vi.fn().mockResolvedValue({ id: "e1", types: [], severity: null });
    const ctx = buildContext(ANALYST, {
      signals: { findMany: signalsFindMany },
      $queryRaw: queryRaw,
      events: { create },
      signalEvents: { createMany: vi.fn() },
    });
    await createEvent(null, { input: baseCreateInput({ signalIds: ["sig1"] }) as never }, ctx);
    expect(create.mock.calls[0][0].data.locationId).toBe("S1");
    expect(resolvePointsToCommonAncestor).not.toHaveBeenCalled();
  });

  it("resolves to the common ancestor when signals span multiple points", async () => {
    const signalsFindMany = vi
      .fn()
      .mockResolvedValue([{ locationId: "S1", originId: "S2", destinationId: null }]);
    const queryRaw = vi.fn().mockResolvedValue([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]);
    (resolvePointsToCommonAncestor as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "ancestor" });
    const create = vi.fn().mockResolvedValue({ id: "e1", types: [], severity: null });
    const ctx = buildContext(ANALYST, {
      signals: { findMany: signalsFindMany },
      $queryRaw: queryRaw,
      events: { create },
      signalEvents: { createMany: vi.fn() },
    });
    await createEvent(null, { input: baseCreateInput({ signalIds: ["sig1"] }) as never }, ctx);
    expect(resolvePointsToCommonAncestor).toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.locationId).toBe("ancestor");
  });

  it("converts population strings to BigInt and leaves undefined fields out", async () => {
    const create = vi.fn().mockResolvedValue({ id: "e1", types: [], severity: 3 });
    const ctx = buildContext(ANALYST, {
      events: { create },
      signalEvents: { createMany: vi.fn() },
    });
    await createEvent(
      null,
      {
        input: baseCreateInput({
          locationId: "L9",
          populationAffected: "1000",
          severity: 3,
        }) as never,
      },
      ctx,
    );
    const data = create.mock.calls[0][0].data;
    expect(data.locationId).toBe("L9");
    expect(data.populationAffected).toBe(BigInt(1000));
    expect(data.populationDisplaced).toBeUndefined();
    expect(data.validFrom).toBeInstanceOf(Date);
  });

  it("dedupes signalIds before creating signalEvents links", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const create = vi.fn().mockResolvedValue({ id: "e1", types: [], severity: null });
    const ctx = buildContext(ANALYST, {
      signals: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      events: { create },
      signalEvents: { createMany },
    });
    await createEvent(
      null,
      { input: baseCreateInput({ locationId: "L1", signalIds: ["a", "a", "b"] }) as never },
      ctx,
    );
    const linked = createMany.mock.calls[0][0].data.map((d: { signalId: string }) => d.signalId);
    expect(linked).toEqual(["a", "b"]);
    expect(createMany.mock.calls[0][0].data.every((d: { eventId: string }) => d.eventId === "e1")).toBe(true);
  });

  it("logs an activity for the actor on create", async () => {
    const create = vi.fn().mockResolvedValue({ id: "e1", title: "T", types: ["flood"], severity: 2 });
    const ctx = buildContext(ANALYST, {
      events: { create },
      signalEvents: { createMany: vi.fn() },
    });
    await createEvent(null, { input: baseCreateInput({ locationId: "L1" }) as never }, ctx);
    expect(logActivity).toHaveBeenCalledWith(
      ctx.prisma,
      expect.objectContaining({
        userId: ANALYST.id,
        action: "event.create",
        resourceType: "event",
        resourceId: "e1",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation.updateEvent
// ---------------------------------------------------------------------------
describe("Mutation.updateEvent", () => {
  it("throws FORBIDDEN for a viewer", async () => {
    await expect(
      updateEvent(null, { id: "e1", input: {} }, buildContext(VIEWER)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the event does not exist", async () => {
    const ctx = buildContext(ADMIN, { events: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      updateEvent(null, { id: "missing", input: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("only links signals not already linked (additive + idempotent)", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "e1" });
    const linkFindMany = vi.fn().mockResolvedValue([{ signalId: "a" }]); // 'a' already linked
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({ id: "e1" });
    const ctx = buildContext(ADMIN, {
      events: { findUnique, update },
      signalEvents: { findMany: linkFindMany, createMany },
    });
    await updateEvent(null, { id: "e1", input: { signalIds: ["a", "b"] } }, ctx);
    const linked = createMany.mock.calls[0][0].data.map((d: { signalId: string }) => d.signalId);
    expect(linked).toEqual(["b"]);
    expect(update).toHaveBeenCalledOnce();
  });

  it("skips the createMany when all supplied signals are already linked", async () => {
    const createMany = vi.fn();
    const ctx = buildContext(ADMIN, {
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1" }), update: vi.fn().mockResolvedValue({ id: "e1" }) },
      signalEvents: { findMany: vi.fn().mockResolvedValue([{ signalId: "a" }]), createMany },
    });
    await updateEvent(null, { id: "e1", input: { signalIds: ["a"] } }, ctx);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("passes through scalar updates as Dates / BigInts", async () => {
    const update = vi.fn().mockResolvedValue({ id: "e1" });
    const ctx = buildContext(ADMIN, {
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1" }), update },
      signalEvents: { findMany: vi.fn(), createMany: vi.fn() },
    });
    await updateEvent(
      null,
      { id: "e1", input: { validFrom: "2026-05-01T00:00:00.000Z", populationDisplaced: "50", title: "New" } },
      ctx,
    );
    const data = update.mock.calls[0][0].data;
    expect(data.validFrom).toBeInstanceOf(Date);
    expect(data.populationDisplaced).toBe(BigInt(50));
    expect(data.title).toBe("New");
    expect(data.casualties).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mutation.deleteEvent
// ---------------------------------------------------------------------------
describe("Mutation.deleteEvent", () => {
  it("throws FORBIDDEN for an analyst (admin-only)", async () => {
    await expect(
      deleteEvent(null, { id: "e1" }, buildContext(ANALYST)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the event does not exist", async () => {
    const ctx = buildContext(ADMIN, { events: { findUnique: vi.fn().mockResolvedValue(null), delete: vi.fn() } });
    await expect(deleteEvent(null, { id: "x" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("deletes and returns true for an admin", async () => {
    const del = vi.fn().mockResolvedValue({ id: "e1" });
    const ctx = buildContext(ADMIN, {
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1" }), delete: del },
    });
    await expect(deleteEvent(null, { id: "e1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "e1" } });
  });
});

// ---------------------------------------------------------------------------
// Mutation.escalateEvent
// ---------------------------------------------------------------------------
describe("Mutation.escalateEvent", () => {
  it("throws FORBIDDEN for a viewer", async () => {
    await expect(
      escalateEvent(null, { eventId: "e1", userId: "u1" }, buildContext(VIEWER)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the event does not exist", async () => {
    const ctx = buildContext(ADMIN, { events: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      escalateEvent(null, { eventId: "missing", userId: "u1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("skips alert creation when a published alert already exists, but still upserts the escalation", async () => {
    const alertsCreate = vi.fn();
    const upsert = vi.fn().mockResolvedValue({ id: "esc1" });
    const ctx = buildContext(ADMIN, {
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1", types: ["flood"], originId: null, destinationId: null, locationId: null }) },
      alerts: { findFirst: vi.fn().mockResolvedValue({ id: "a1" }), create: alertsCreate },
      eventEscaladedByUsers: { upsert },
    });
    const result = await escalateEvent(null, { eventId: "e1", userId: "u9" }, ctx);
    expect(alertsCreate).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].where).toEqual({ userId_eventId: { userId: "u9", eventId: "e1" } });
    expect(result).toEqual({ id: "esc1" });
  });

  it("creates an alert when none exists, then skips fan-out when the event has no locations", async () => {
    const alertsCreate = vi.fn().mockResolvedValue({ id: "a-new" });
    const upsert = vi.fn().mockResolvedValue({ id: "esc1" });
    const locationsFindMany = vi.fn();
    const ctx = buildContext(ADMIN, {
      // No location ids → fan-out branch is skipped entirely.
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1", types: ["flood"], originId: null, destinationId: null, locationId: null }) },
      alerts: { findFirst: vi.fn().mockResolvedValue(null), create: alertsCreate },
      locations: { findMany: locationsFindMany },
      eventEscaladedByUsers: { upsert },
    });
    await escalateEvent(null, { eventId: "e1", userId: "u9" }, ctx);
    expect(alertsCreate).toHaveBeenCalledWith({ data: { eventId: "e1", status: "published" } });
    expect(locationsFindMany).not.toHaveBeenCalled(); // no locations → no subscriber search
    expect(upsert).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Event field resolvers
// ---------------------------------------------------------------------------
describe("Event.title (locale overlay)", () => {
  it("returns the canonical title for the default locale", async () => {
    const ctx = buildContext(VIEWER, {}, "en");
    await expect(
      eventResolvers.Event.title({ id: "e1", title: "Canonical" }, {}, ctx),
    ).resolves.toBe("Canonical");
  });

  it("returns the localized title from the pre-included translation row", async () => {
    const ctx = buildContext(VIEWER, {}, "ar");
    const parent = { id: "e1", title: "Canonical", translations: [{ data: { title: "مترجم" } }] };
    await expect(eventResolvers.Event.title(parent, {}, ctx)).resolves.toBe("مترجم");
    expect(enqueueTranslationDurable).not.toHaveBeenCalled();
  });

  it("falls back to canonical and enqueues a translation when the included row is empty", async () => {
    const ctx = buildContext(VIEWER, {}, "ar");
    const parent = { id: "e1", title: "Canonical", translations: [] };
    await expect(eventResolvers.Event.title(parent, {}, ctx)).resolves.toBe("Canonical");
    expect(enqueueTranslationDurable).toHaveBeenCalledWith(ctx.prisma, "event", "e1", "ar");
  });

  it("uses the per-request translationLoader when translations were not pre-included", async () => {
    const load = vi.fn().mockResolvedValue({ title: "FromLoader" });
    const ctx = buildContext(VIEWER, {}, "ar", { load });
    const parent = { id: "e1", title: "Canonical" };
    await expect(eventResolvers.Event.title(parent, {}, ctx)).resolves.toBe("FromLoader");
    expect(load).toHaveBeenCalledWith("event", "e1");
  });
});

describe("Event.signals", () => {
  const infoWithSelections = (names: string[]): GraphQLResolveInfo =>
    ({
      fieldNodes: [
        {
          selectionSet: {
            selections: names.map((value) => ({ kind: "Field", name: { value } })),
          },
        },
      ],
    }) as unknown as GraphQLResolveInfo;

  it("uses the pre-loaded fast path when parent.signalEvents is present", () => {
    const ctx = buildContext(VIEWER, {});
    const parent = { id: "e1", signalEvents: [{ signal: { id: "s1" } }, { signal: { id: "s2" } }] };
    const result = eventResolvers.Event.signals(parent, {}, ctx, infoWithSelections([]));
    expect(result).toEqual([{ id: "s1" }, { id: "s2" }]);
  });

  it("omits location includes when the selection does not ask for them", async () => {
    const findMany = vi.fn().mockResolvedValue([{ signal: { id: "s1" } }]);
    const ctx = buildContext(VIEWER, { signalEvents: { findMany } }, "ar");
    await eventResolvers.Event.signals({ id: "e1" }, {}, ctx, infoWithSelections(["source"]));
    const include = findMany.mock.calls[0][0].include.signal.include;
    expect(include.generalLocation).toBeUndefined();
    expect(findMany.mock.calls[0][0].where).toEqual({ eventId: "e1" });
    expect(findMany.mock.calls[0][0].take).toBe(50);
  });

  it("adds location includes when the selection requests a signal location", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { signalEvents: { findMany } }, "ar");
    await eventResolvers.Event.signals({ id: "e1" }, {}, ctx, infoWithSelections(["generalLocation"]));
    const include = findMany.mock.calls[0][0].include.signal.include;
    expect(include.generalLocation).toEqual({ include: { translations: { where: { locale: "ar" } } } });
  });
});

describe("Event.originLocation / generalLocation", () => {
  it("returns the pre-loaded location without a query (fast path)", () => {
    const ctx = buildContext(VIEWER, {});
    const preloaded = { id: "L1" };
    expect(
      eventResolvers.Event.originLocation({ originId: "L1", originLocation: preloaded }, {}, ctx),
    ).toBe(preloaded);
  });

  it("returns null when there is no originId", () => {
    const ctx = buildContext(VIEWER, {});
    expect(eventResolvers.Event.originLocation({ originId: null }, {}, ctx)).toBeNull();
  });

  it("queries locations.findUnique with the locale include when not pre-loaded", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "L1" });
    const ctx = buildContext(VIEWER, { locations: { findUnique } }, "fr");
    await eventResolvers.Event.generalLocation({ locationId: "L1" }, {}, ctx);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "L1" },
      include: { translations: { where: { locale: "fr" } } },
    });
  });
});

describe("Event scalar transforms", () => {
  it("maps description_signals snake_case to camelCase, null when absent", () => {
    expect(eventResolvers.Event.descriptionSignals({ description_signals: { a: 1 } })).toEqual({ a: 1 });
    expect(eventResolvers.Event.descriptionSignals({})).toBeNull();
  });

  it("stringifies BigInt population fields, null when absent", () => {
    expect(eventResolvers.Event.populationAffected({ populationAffected: BigInt(1234) })).toBe("1234");
    expect(eventResolvers.Event.populationAffected({ populationAffected: null })).toBeNull();
    expect(eventResolvers.Event.populationDisplaced({ populationDisplaced: BigInt(7) })).toBe("7");
    expect(eventResolvers.Event.populationDisplaced({ populationDisplaced: null })).toBeNull();
  });
});

describe("Event.representativePoint — delegates to the loader", () => {
  const rp = eventResolvers.Event.representativePoint;

  // The resolver only touches context.representativePointLoader; the
  // first-signal / cascade logic lives in the loader's own test.
  function ctxWithLoader(load: ReturnType<typeof vi.fn>) {
    return { representativePointLoader: { load } } as unknown as Context;
  }

  it("returns the eager-loaded value without touching the loader", async () => {
    const load = vi.fn();
    const preset = { id: "loc-pre" };
    expect(await rp({ id: "e1", representativePoint: preset }, {}, ctxWithLoader(load)))
      .toBe(preset);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads by the event's id and returns the loader result", async () => {
    const loc = { id: "loc-first" };
    const load = vi.fn().mockResolvedValue(loc);
    expect(await rp({ id: "e1" }, {}, ctxWithLoader(load))).toBe(loc);
    expect(load).toHaveBeenCalledWith("e1");
  });
});
