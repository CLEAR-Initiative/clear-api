/**
 * Unit tests for `crisis.resolver.ts`.
 *
 * DB-FREE: every `context.prisma.*` delegate the resolver touches is a
 * `vi.fn()` stub built per-test by `buildContext`. No real Prisma client,
 * no database, no `describeIfDb`. All imported modules that reach external
 * services are `vi.mock(...)`ed BEFORE the resolver import so they never
 * run in CI:
 *   - `../../src/services/celery.js`      (Redis broker — enrichment dispatch + translation buffer)
 *   - `../../src/utils/geo-resolve.js`    (pulled in transitively by location-scope)
 *   - `../../src/utils/location-scope.js` (DB-walking team location filter)
 *   - `../../src/utils/activity-log.js`   (audit-log writer)
 *   - `../../src/services/s3.js`          (presigned-URL signer, dynamically imported)
 *
 * Coverage — the branches with real logic:
 *   Query.crisis                 — auth gate, NOT_FOUND, locale-aware include.
 *   Query.crises                 — auth gate, admin bypasses location scope vs
 *                                  non-admin builds the scoped where clause.
 *   createCrisisFromEvents       — role gate, empty-eventIds BAD_USER_INPUT,
 *                                  missing-event NOT_FOUND, default-value logic,
 *                                  generate-narrative flag derivation.
 *   addEventToCrisis             — role gate, crisis/event NOT_FOUND,
 *                                  idempotent existing-link short-circuit.
 *   removeEventFromCrisis        — role gate, crisis/link NOT_FOUND,
 *                                  last-event auto-delete (returns null) vs
 *                                  multi-event recompute path.
 *   addCrisisAttachments         — auth gate, NOT_FOUND, dedupe + skip-empty.
 *   removeCrisisAttachment       — auth gate, NOT_FOUND, filter-out.
 *   updateCrisisTitle            — auth gate, NOT_FOUND, audit-row diff text.
 *   updateCrisisDescription      — auth gate, NOT_FOUND, JSON-summary merge,
 *                                  legacy plain-string promotion.
 *   deleteCrisis                 — role gate, NOT_FOUND, success.
 *   setCrisisNeedsAnalysis       — role gate, NOT_FOUND (the raw-SQL merge
 *                                  itself is not exercised — see SKIPPED).
 *   updateCrisisPopulation       — role gate, NOT_FOUND, BigInt coercion,
 *                                  null→SQL-NULL handling, the title-lock branch.
 *   Crisis.title/summary/scenarios/needs — locale short-circuit + translation
 *                                  overlay fast path.
 *   Crisis.populationAffected/InArea     — BigInt→string / null.
 *   Crisis.events                — parent fast-path vs lazy fetch.
 *   Crisis.generalLocation       — null vs lookup.
 *   Crisis.attachments           — empty list + http passthrough / presign.
 *
 * SKIPPED (cannot run DB-free or no branching worth a unit test):
 *   - The `$transaction` *body* in createCrisisFromEvents / updateCrisisTitle:
 *     we stub `$transaction` to drive the outer logic but don't assert the
 *     real interactive/array transaction semantics (those need a DB).
 *   - The Postgres `||` JSONB merge in setCrisisNeedsAnalysis (raw `$executeRaw`).
 *   - Trivial passthrough field resolvers (EventCrisis.crisis/event,
 *     Crisis.feedbacks/comments) — one-line findMany/findUnique, no logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

vi.mock("../../src/services/celery.js", () => ({
  sendCeleryTask: vi.fn().mockResolvedValue(undefined),
  bufferTranslationRequest: vi.fn(),
}));
vi.mock("../../src/utils/geo-resolve.js", () => ({
  getLocationIdsWithDescendants: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/utils/location-scope.js", () => ({
  buildCrisisLocationFilterForUser: vi.fn().mockResolvedValue({ id: { in: ["c1"] } }),
}));
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrl: vi.fn(async (key: string) => `https://signed/${key}`),
}));

import { crisisResolvers } from "../../src/resolvers/crisis.resolver.js";
import { buildCrisisLocationFilterForUser } from "../../src/utils/location-scope.js";
import { sendCeleryTask } from "../../src/services/celery.js";
import { logActivity } from "../../src/utils/activity-log.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(
  user: User,
  prisma: Record<string, unknown> = {},
  extra: Partial<Context> = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
    ...extra,
  } as Context;
}

const { crisis, crises } = crisisResolvers.Query;
const {
  createCrisisFromEvents,
  addEventToCrisis,
  removeEventFromCrisis,
  addCrisisAttachments,
  removeCrisisAttachment,
  updateCrisisTitle,
  updateCrisisDescription,
  deleteCrisis,
  setCrisisNeedsAnalysis,
  updateCrisisPopulation,
} = crisisResolvers.Mutation;

const ADMIN = { id: "admin1", role: "admin" };
const ANALYST = { id: "an1", role: "analyst" };
const VIEWER = { id: "v1", role: "viewer" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Query.crisis
// ---------------------------------------------------------------------------
describe("Query.crisis", () => {
  it("returns the crisis for an authenticated caller", async () => {
    const row = { id: "c1" };
    const findUnique = vi.fn().mockResolvedValue(row);
    const ctx = buildContext(VIEWER, { crises: { findUnique } });
    expect(await crisis(null, { id: "c1" }, ctx)).toBe(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("adds a translations include for a non-default locale", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, { crises: { findUnique } }, { locale: "ar" });
    await crisis(null, { id: "c1" }, ctx);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "c1" },
      include: { translations: { where: { locale: "ar" } } },
    });
  });

  it("throws NOT_FOUND when the crisis does not exist", async () => {
    const ctx = buildContext(VIEWER, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(crisis(null, { id: "missing" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(crisis(null, { id: "c1" }, buildContext(null))).rejects.toThrow(GraphQLError);
  });
});

// ---------------------------------------------------------------------------
// Query.crises
// ---------------------------------------------------------------------------
describe("Query.crises", () => {
  it("bypasses the location filter for global admins (where: undefined)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(ADMIN, { crises: { findMany } });
    await crises(null, {}, ctx);
    expect(buildCrisisLocationFilterForUser).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({ where: undefined });
  });

  it("applies the scoped where clause for non-admins", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(VIEWER, { crises: { findMany } });
    await crises(null, {}, ctx);
    expect(buildCrisisLocationFilterForUser).toHaveBeenCalledWith(ctx.prisma, "v1");
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["c1"] } } });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(crises(null, {}, buildContext(null))).rejects.toThrow(GraphQLError);
  });
});

// ---------------------------------------------------------------------------
// Mutation.createCrisisFromEvents
// ---------------------------------------------------------------------------
describe("Mutation.createCrisisFromEvents", () => {
  function makeCtx(user: User, opts: { events?: Array<{ id: string }>; created?: { id: string; title?: string | null; severity?: number } } = {}) {
    const events = opts.events ?? [{ id: "e1" }];
    const created = opts.created ?? { id: "c-new", title: null, severity: 3 };
    const createMany = vi.fn().mockResolvedValue({ count: events.length });
    const create = vi.fn().mockResolvedValue(created);
    const prisma = {
      events: {
        // findMany is called for validation, then for population sum, then by collectDistrictIds.
        findMany: vi.fn().mockImplementation(({ select }: { select: Record<string, boolean> }) => {
          if (select?.id) return Promise.resolve(events);
          if (select?.populationAffected) return Promise.resolve([{ populationAffected: 10n }]);
          // collectDistrictIds origin/destination/location select
          return Promise.resolve([]);
        }),
      },
      locations: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ crises: { create }, eventCrises: { createMany } }),
      ),
    };
    return { ctx: buildContext(user, prisma), create, createMany };
  }

  it("rejects a viewer with FORBIDDEN", async () => {
    const { ctx } = makeCtx(VIEWER);
    await expect(
      createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1"] } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("allows an analyst", async () => {
    const { ctx, create } = makeCtx(ANALYST);
    await createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1"] } }, ctx);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects an empty eventIds list with BAD_USER_INPUT", async () => {
    const { ctx, create } = makeCtx(ADMIN);
    await expect(
      createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: [] } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND listing the missing event ids", async () => {
    const { ctx } = makeCtx(ADMIN, { events: [{ id: "e1" }] }); // only e1 exists
    await expect(
      createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1", "e2"] } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await expect(
      createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1", "e2"] } }, ctx),
    ).rejects.toThrow(/e2/);
  });

  it("dispatches enrichment with generate_narrative=true when title/summary missing", async () => {
    const { ctx } = makeCtx(ADMIN, { events: [{ id: "e1" }] });
    await createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1"] } }, ctx);
    // settle the fire-and-forget dispatch
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCeleryTask).toHaveBeenCalledWith(
      "src.tasks.crisis.enrich_crisis",
      expect.objectContaining({ crisis_id: "c-new", generate_narrative: true }),
    );
  });

  it("derives generate_narrative=false when both title and summary supplied", async () => {
    const { ctx } = makeCtx(ADMIN, { events: [{ id: "e1" }] });
    await createCrisisFromEvents(
      null,
      { input: { title: "T", summary: "S", severity: 2, needs: {}, eventIds: ["e1"] } },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCeleryTask).toHaveBeenCalledWith(
      "src.tasks.crisis.enrich_crisis",
      expect.objectContaining({ generate_narrative: false }),
    );
  });

  it("logs the crisis.create activity for the actor", async () => {
    const { ctx } = makeCtx(ADMIN, { events: [{ id: "e1" }] });
    await createCrisisFromEvents(null, { input: { severity: 2, needs: {}, eventIds: ["e1"] } }, ctx);
    expect(logActivity).toHaveBeenCalledWith(
      ctx.prisma,
      expect.objectContaining({ userId: "admin1", action: "crisis.create", resourceId: "c-new" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation.addEventToCrisis
// ---------------------------------------------------------------------------
describe("Mutation.addEventToCrisis", () => {
  it("rejects a viewer with FORBIDDEN", async () => {
    const ctx = buildContext(VIEWER, {});
    await expect(
      addEventToCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue(null) },
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1" }) },
    });
    await expect(
      addEventToCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("throws NOT_FOUND when the event is missing", async () => {
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }) },
      events: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      addEventToCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx),
    ).rejects.toThrow(/Event not found/);
  });

  it("is idempotent — returns the existing link without creating a new one", async () => {
    const existing = { id: "link1", crisisId: "c1", eventId: "e1" };
    const create = vi.fn();
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }) },
      events: { findUnique: vi.fn().mockResolvedValue({ id: "e1" }) },
      eventCrises: { findFirst: vi.fn().mockResolvedValue(existing), create },
    });
    expect(await addEventToCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx)).toBe(existing);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates the link, recomputes population, and dispatches enrichment", async () => {
    const link = { id: "link1", crisisId: "c1", eventId: "e1" };
    const create = vi.fn().mockResolvedValue(link);
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update },
      events: {
        findUnique: vi.fn().mockResolvedValue({ id: "e1" }),
        findMany: vi.fn().mockResolvedValue([{ populationAffected: 5n }]),
      },
      locations: { findMany: vi.fn().mockResolvedValue([]) },
      eventCrises: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
        findMany: vi.fn().mockResolvedValue([{ eventId: "e1" }]),
      },
    });
    expect(await addEventToCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx)).toBe(link);
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { populationAffected: 5n, enrichmentStatus: "PENDING" } });
    await Promise.resolve();
    expect(sendCeleryTask).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mutation.removeEventFromCrisis
// ---------------------------------------------------------------------------
describe("Mutation.removeEventFromCrisis", () => {
  it("rejects a viewer with FORBIDDEN", async () => {
    await expect(
      removeEventFromCrisis(null, { crisisId: "c1", eventId: "e1" }, buildContext(VIEWER, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(ADMIN, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      removeEventFromCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("throws NOT_FOUND when the event is not linked", async () => {
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }) },
      eventCrises: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      removeEventFromCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx),
    ).rejects.toThrow(/not linked/);
  });

  it("auto-deletes the crisis and returns null when removing the last event", async () => {
    const del = vi.fn().mockResolvedValue({ id: "c1" });
    const deleteMany = vi.fn();
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), delete: del },
      eventCrises: {
        findFirst: vi.fn().mockResolvedValue({ eventId: "e1", crisisId: "c1" }),
        count: vi.fn().mockResolvedValue(1),
        deleteMany,
      },
    });
    expect(await removeEventFromCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx)).toBeNull();
    expect(del).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("removes the link and recomputes population when other events remain", async () => {
    const updated = { id: "c1", populationAffected: 7n };
    const update = vi.fn().mockResolvedValue(updated);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const del = vi.fn();
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update, delete: del },
      events: { findMany: vi.fn().mockResolvedValue([{ populationAffected: 7n }]) },
      locations: { findMany: vi.fn().mockResolvedValue([]) },
      eventCrises: {
        findFirst: vi.fn().mockResolvedValue({ eventId: "e1", crisisId: "c1" }),
        count: vi.fn().mockResolvedValue(2),
        deleteMany,
        findMany: vi.fn().mockResolvedValue([{ eventId: "e2" }]),
      },
    });
    expect(await removeEventFromCrisis(null, { crisisId: "c1", eventId: "e1" }, ctx)).toBe(updated);
    expect(del).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledWith({ where: { crisisId: "c1", eventId: "e1" } });
    expect(update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { populationAffected: 7n, enrichmentStatus: "PENDING" } });
  });
});

// ---------------------------------------------------------------------------
// Mutation.addCrisisAttachments
// ---------------------------------------------------------------------------
describe("Mutation.addCrisisAttachments", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      addCrisisAttachments(null, { id: "c1", keys: ["k"] }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(VIEWER, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      addCrisisAttachments(null, { id: "c1", keys: ["k"] }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("appends new keys, dedupes against existing, and skips empties", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ attachments: ["a", "b"] }), update },
    });
    await addCrisisAttachments(null, { id: "c1", keys: ["b", "c", "", "c"] }, ctx);
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { attachments: ["a", "b", "c"] },
    });
  });

  it("handles a null existing attachments list", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ attachments: null }), update },
    });
    await addCrisisAttachments(null, { id: "c1", keys: ["x"] }, ctx);
    expect(update.mock.calls[0][0].data.attachments).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// Mutation.removeCrisisAttachment
// ---------------------------------------------------------------------------
describe("Mutation.removeCrisisAttachment", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      removeCrisisAttachment(null, { id: "c1", key: "k" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(VIEWER, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      removeCrisisAttachment(null, { id: "c1", key: "k" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("filters the key out of the list (idempotent on a missing key)", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ attachments: ["a", "b"] }), update },
    });
    await removeCrisisAttachment(null, { id: "c1", key: "a" }, ctx);
    expect(update.mock.calls[0][0].data.attachments).toEqual(["b"]);

    update.mockClear();
    await removeCrisisAttachment(null, { id: "c1", key: "zzz" }, ctx);
    expect(update.mock.calls[0][0].data.attachments).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Mutation.updateCrisisTitle
// ---------------------------------------------------------------------------
describe("Mutation.updateCrisisTitle", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      updateCrisisTitle(null, { id: "c1", title: "T" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(VIEWER, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      updateCrisisTitle(null, { id: "c1", title: "T" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("updates the title and writes an audit feedback row with the old→new diff", async () => {
    const updated = { id: "c1", title: "New" };
    const updateCall = { kind: "update" };
    const createCall = { kind: "create" };
    const update = vi.fn().mockReturnValue(updateCall);
    const create = vi.fn().mockReturnValue(createCall);
    const $transaction = vi.fn().mockResolvedValue([updated, { id: "fb1" }]);
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1", title: "Old" }), update },
      userFeedbacks: { create },
      $transaction,
    });
    expect(await updateCrisisTitle(null, { id: "c1", title: "New" }, ctx)).toBe(updated);
    expect(update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { title: "New" } });
    const fbData = create.mock.calls[0][0].data;
    expect(fbData).toMatchObject({ userId: "v1", crisisId: "c1", rating: 0 });
    expect(fbData.text).toBe("[title-edit] Old → New");
    expect($transaction).toHaveBeenCalledWith([updateCall, createCall]);
  });

  it("renders (empty) sentinels for null old title / blank new title", async () => {
    const create = vi.fn().mockReturnValue({});
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1", title: null }), update: vi.fn().mockReturnValue({}) },
      userFeedbacks: { create },
      $transaction: vi.fn().mockResolvedValue([{ id: "c1" }, {}]),
    });
    await updateCrisisTitle(null, { id: "c1", title: "" }, ctx);
    expect(create.mock.calls[0][0].data.text).toBe("[title-edit] (empty) → (empty)");
  });
});

// ---------------------------------------------------------------------------
// Mutation.updateCrisisDescription
// ---------------------------------------------------------------------------
describe("Mutation.updateCrisisDescription", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      updateCrisisDescription(null, { id: "c1", description: "d" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(VIEWER, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      updateCrisisDescription(null, { id: "c1", description: "d" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("merges the new description into existing JSON summary, preserving tldr", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c1",
          summary: JSON.stringify({ description: "old", tldr: ["a", "b"] }),
        }),
        update,
      },
    });
    await updateCrisisDescription(null, { id: "c1", description: "new" }, ctx);
    expect(JSON.parse(update.mock.calls[0][0].data.summary)).toEqual({
      description: "new",
      tldr: ["a", "b"],
    });
  });

  it("promotes a legacy plain-string summary to the structured shape", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", summary: "just a plain string" }),
        update,
      },
    });
    await updateCrisisDescription(null, { id: "c1", description: "new" }, ctx);
    expect(JSON.parse(update.mock.calls[0][0].data.summary)).toEqual({
      description: "new",
      tldr: [],
    });
  });

  it("defaults to the structured shape when summary is null", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(VIEWER, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1", summary: null }), update },
    });
    await updateCrisisDescription(null, { id: "c1", description: "new" }, ctx);
    expect(JSON.parse(update.mock.calls[0][0].data.summary)).toEqual({ description: "new", tldr: [] });
  });
});

// ---------------------------------------------------------------------------
// Mutation.deleteCrisis
// ---------------------------------------------------------------------------
describe("Mutation.deleteCrisis", () => {
  it("rejects a viewer with FORBIDDEN", async () => {
    await expect(
      deleteCrisis(null, { id: "c1" }, buildContext(VIEWER, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects an analyst with FORBIDDEN (admin-only)", async () => {
    await expect(
      deleteCrisis(null, { id: "c1" }, buildContext(ANALYST, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(ADMIN, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(deleteCrisis(null, { id: "c1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("deletes and returns true for an admin", async () => {
    const del = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), delete: del },
    });
    expect(await deleteCrisis(null, { id: "c1" }, ctx)).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});

// ---------------------------------------------------------------------------
// Mutation.setCrisisNeedsAnalysis
// ---------------------------------------------------------------------------
describe("Mutation.setCrisisNeedsAnalysis", () => {
  it("rejects an analyst with FORBIDDEN (admin-only)", async () => {
    await expect(
      setCrisisNeedsAnalysis(null, { id: "c1", generalSummary: [], sector: {} }, buildContext(ANALYST, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(ADMIN, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      setCrisisNeedsAnalysis(null, { id: "c1", generalSummary: [], sector: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("runs the JSONB merge and returns the refreshed crisis for an admin", async () => {
    const refreshed = { id: "c1", needs: { generalSummary: ["x"] } };
    const $executeRaw = vi.fn().mockResolvedValue(1);
    const findUniqueOrThrow = vi.fn().mockResolvedValue(refreshed);
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), findUniqueOrThrow },
      $executeRaw,
    });
    expect(
      await setCrisisNeedsAnalysis(null, { id: "c1", generalSummary: ["x"], sector: { wash: 1 } }, ctx),
    ).toBe(refreshed);
    expect($executeRaw).toHaveBeenCalledOnce();
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});

// ---------------------------------------------------------------------------
// Mutation.updateCrisisPopulation
// ---------------------------------------------------------------------------
describe("Mutation.updateCrisisPopulation", () => {
  it("rejects an analyst with FORBIDDEN (admin-only)", async () => {
    await expect(
      updateCrisisPopulation(null, { id: "c1", input: {} }, buildContext(ANALYST, {})),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the crisis is missing", async () => {
    const ctx = buildContext(ADMIN, { crises: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(
      updateCrisisPopulation(null, { id: "c1", input: {} }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("coerces population strings to BigInt and passes null through", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update },
    });
    await updateCrisisPopulation(
      null,
      { id: "c1", input: { populationAffected: "1000", populationInArea: null } },
      ctx,
    );
    const data = update.mock.calls[0][0].data;
    expect(data.populationAffected).toBe(1000n);
    expect(data.populationInArea).toBeNull();
  });

  it("maps a null scenarios input to Prisma.DbNull and a value through as-is", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update },
    });
    await updateCrisisPopulation(null, { id: "c1", input: { scenarios: null } }, ctx);
    // Prisma.DbNull is an object sentinel, not JS null.
    expect(update.mock.calls[0][0].data.scenarios).not.toBeNull();
    expect(update.mock.calls[0][0].data.scenarios).toBeTypeOf("object");

    update.mockClear();
    await updateCrisisPopulation(null, { id: "c1", input: { scenarios: { worst_case: "x" } } }, ctx);
    expect(update.mock.calls[0][0].data.scenarios).toEqual({ worst_case: "x" });
  });

  it("writes the title when no manual title-edit audit row exists", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update },
      userFeedbacks: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await updateCrisisPopulation(null, { id: "c1", input: { title: "Pipeline Title" } }, ctx);
    expect(update.mock.calls[0][0].data.title).toBe("Pipeline Title");
  });

  it("title-lock: drops the title when a manual title-edit audit row exists", async () => {
    const update = vi.fn().mockResolvedValue({ id: "c1" });
    const ctx = buildContext(ADMIN, {
      crises: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }), update },
      userFeedbacks: {
        findFirst: vi.fn().mockResolvedValue({ id: "fb1", createdAt: new Date("2026-01-01") }),
      },
    });
    await updateCrisisPopulation(null, { id: "c1", input: { title: "Pipeline Title", summary: "S" } }, ctx);
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("title");
    // ...but other fields still flow through.
    expect(data.summary).toBe("S");
  });
});

// ---------------------------------------------------------------------------
// Crisis field resolvers (localization + transforms)
// ---------------------------------------------------------------------------
const C = crisisResolvers.Crisis;

describe("Crisis.title / summary / scenarios / needs (localization)", () => {
  it("returns the canonical column at the default locale", async () => {
    const ctx = buildContext(VIEWER, {}, { locale: "en" });
    expect(await C.title({ id: "c1", title: "Canon" }, {}, ctx)).toBe("Canon");
    expect(await C.summary({ id: "c1", summary: "Sum" }, {}, ctx)).toBe("Sum");
    expect(await C.scenarios({ id: "c1", scenarios: { a: 1 } }, {}, ctx)).toEqual({ a: 1 });
    expect(await C.needs({ id: "c1", needs: { n: 1 } }, {}, ctx)).toEqual({ n: 1 });
  });

  it("uses the translations overlay fast path for a non-default locale", async () => {
    const ctx = buildContext(VIEWER, {}, { locale: "ar" });
    const parent = { id: "c1", title: "Canon", translations: [{ data: { title: "مرحبا" } }] };
    expect(await C.title(parent, {}, ctx)).toBe("مرحبا");
  });

  it("falls back to the canonical column when a non-default locale has no overlay row", async () => {
    const ctx = buildContext(VIEWER, {}, { locale: "ar" });
    const parent = { id: "c1", title: "Canon", translations: [] as Array<{ data: unknown }> };
    expect(await C.title(parent, {}, ctx)).toBe("Canon");
  });
});

describe("Crisis.populationAffected / populationInArea", () => {
  it("stringifies a BigInt and returns null when absent", () => {
    expect(C.populationAffected({ populationAffected: 1234n })).toBe("1234");
    expect(C.populationAffected({ populationAffected: null })).toBeNull();
    expect(C.populationInArea({ populationInArea: 9n })).toBe("9");
    expect(C.populationInArea({ populationInArea: null })).toBeNull();
  });
});

describe("Crisis.generalLocation", () => {
  it("returns null when there is no locationId", () => {
    const ctx = buildContext(VIEWER, { locations: { findUnique: vi.fn() } });
    expect(C.generalLocation({ locationId: null }, {}, ctx)).toBeNull();
  });

  it("looks up the location when present", () => {
    const findUnique = vi.fn().mockReturnValue({ id: "loc1" });
    const ctx = buildContext(VIEWER, { locations: { findUnique } });
    C.generalLocation({ locationId: "loc1" }, {}, ctx);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "loc1" } });
  });
});

describe("Crisis.events", () => {
  it("uses the deep-include fast path off the parent", async () => {
    const ctx = buildContext(VIEWER, {});
    const result = C.events({ id: "c1", eventCrises: [{ event: { id: "e1" } }, { event: { id: "e2" } }] }, {}, ctx);
    expect(result).toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("lazily fetches links when the parent has no eventCrises", async () => {
    const findMany = vi.fn().mockResolvedValue([{ event: { id: "e1" } }]);
    const ctx = buildContext(VIEWER, { eventCrises: { findMany } });
    const result = await C.events({ id: "c1" }, {}, ctx);
    expect(findMany).toHaveBeenCalledWith({ where: { crisisId: "c1" }, include: { event: true } });
    expect(result).toEqual([{ id: "e1" }]);
  });
});

describe("Crisis.attachments", () => {
  it("returns an empty array for null/empty attachments", async () => {
    expect(await C.attachments({ attachments: null })).toEqual([]);
    expect(await C.attachments({ attachments: [] })).toEqual([]);
  });

  it("passes external http(s) URLs through and presigns S3 keys", async () => {
    const result = await C.attachments({ attachments: ["https://ext/img.png", "uploads/a.png"] });
    expect(result).toEqual(["https://ext/img.png", "https://signed/uploads/a.png"]);
  });
});
