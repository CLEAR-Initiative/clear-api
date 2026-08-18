/**
 * Unit tests for `translation.resolver.ts`.
 *
 * DB-free: every `context.prisma.*` table is stubbed with `vi.fn()` delegates;
 * no real Prisma client is imported and no DB connection is made. The pure
 * helpers from `../../src/utils/locales.js` (isSupportedLocale, SUPPORTED_LOCALES,
 * DEFAULT_LOCALE) are allowed to run for real — they are constant lookups.
 *
 * Coverage:
 *   Query.translations
 *     - role gate (admin/pipeline allowed, viewer/unauth rejected)
 *     - entityType normalisation (case-insensitive) + invalid-type rejection
 *     - delegates to translations.findMany with normalised where + ordering
 *   Query.entitiesMissingTranslation
 *     - role gate
 *     - invalid entityType, 'en' canonical rejection, unsupported locale
 *     - routes to the correct canonical table per entityType
 *     - Set-diff logic: returns only untranslated ids
 *   Query.translationCoverage
 *     - admin-only gate (pipeline rejected)
 *     - builds the full type x locale matrix, skips 'en', zero-fills gaps
 *   Mutation.upsertTranslations
 *     - role gate
 *     - invalid entityType, empty translations
 *     - per-locale validation: 'en' rejection, unsupported locale, duplicate
 *       locale, non-object data, non-object sourceHashes
 *     - assertEntityExists NOT_FOUND short-circuit (no transaction)
 *     - transaction builds one upsert per locale with the right typed FK,
 *       canonical lowercased locale, and returns the normalised summary
 *
 * Skipped (no unit-testable logic): the raw groupBy/count plumbing is exercised
 * via the matrix assertions; there are no other branches worth isolating.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { translationResolvers } from "../../src/resolvers/translation.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

/** Build a Context with an arbitrary prisma stub shape. */
function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const admin: User = { id: "a1", role: "admin" };
const pipeline: User = { id: "p1", role: "pipeline" };
const viewer: User = { id: "v1", role: "viewer" };

/** Shape of the single argument passed to the mocked `translations.upsert`,
 *  used to narrow `upsert.mock.calls[i][0]` (typed `unknown` by the vi.fn stub)
 *  when asserting on the where/create/update payloads below. */
type UpsertArg = {
  where: {
    entityType_entityId_locale: {
      entityType: string;
      entityId: string;
      locale: string;
    };
  };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

const { translations, entitiesMissingTranslation, translationCoverage } =
  translationResolvers.Query;
const { upsertTranslations } = translationResolvers.Mutation;

describe("Query.translations", () => {
  it("returns rows filtered by normalised entityType + entityId, locale-ordered", async () => {
    const rows = [{ id: "t1" }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const ctx = buildContext(admin, { translations: { findMany } });

    // entityType supplied upper-cased — resolver lowercases it.
    const result = await translations(null, { entityType: "EVENT", entityId: "e1" }, ctx);

    expect(result).toBe(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { entityType: "event", entityId: "e1" },
      orderBy: { locale: "asc" },
    });
  });

  it("allows the pipeline role", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext(pipeline, { translations: { findMany } });
    await translations(null, { entityType: "crisis", entityId: "c1" }, ctx);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("rejects a viewer with FORBIDDEN before touching prisma", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(viewer, { translations: { findMany } });
    await expect(
      translations(null, { entityType: "event", entityId: "e1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      translations(null, { entityType: "event", entityId: "e1" }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("rejects an invalid entityType with BAD_USER_INPUT", async () => {
    const findMany = vi.fn();
    const ctx = buildContext(admin, { translations: { findMany } });
    await expect(
      translations(null, { entityType: "user", entityId: "e1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("Query.entitiesMissingTranslation", () => {
  function buildCtx(
    user: User,
    opts: {
      events?: Array<{ id: string }>;
      crises?: Array<{ id: string }>;
      locations?: Array<{ id: string }>;
      translated?: Array<{ entityId: string }>;
    } = {},
  ) {
    const eventsFind = vi.fn().mockResolvedValue(opts.events ?? []);
    const crisesFind = vi.fn().mockResolvedValue(opts.crises ?? []);
    const locationsFind = vi.fn().mockResolvedValue(opts.locations ?? []);
    const translationsFind = vi.fn().mockResolvedValue(opts.translated ?? []);
    const ctx = buildContext(user, {
      events: { findMany: eventsFind },
      crises: { findMany: crisesFind },
      locations: { findMany: locationsFind },
      translations: { findMany: translationsFind },
    });
    return { ctx, eventsFind, crisesFind, locationsFind, translationsFind };
  }

  it("returns canonical ids that have no translation row for the locale", async () => {
    const { ctx, eventsFind, translationsFind } = buildCtx(admin, {
      events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
      translated: [{ entityId: "e2" }],
    });
    const result = await entitiesMissingTranslation(
      null,
      { entityType: "event", locale: "ar" },
      ctx,
    );
    expect(result).toEqual(["e1", "e3"]);
    expect(eventsFind).toHaveBeenCalledWith({ select: { id: true } });
    expect(translationsFind).toHaveBeenCalledWith({
      where: { entityType: "event", locale: "ar" },
      select: { entityId: true },
    });
  });

  it("routes to the crises table for entityType=crisis (case-insensitive)", async () => {
    const { ctx, crisesFind, eventsFind, locationsFind } = buildCtx(admin, {
      crises: [{ id: "c1" }],
    });
    const result = await entitiesMissingTranslation(
      null,
      { entityType: "CRISIS", locale: "FR" },
      ctx,
    );
    expect(result).toEqual(["c1"]);
    expect(crisesFind).toHaveBeenCalledOnce();
    expect(eventsFind).not.toHaveBeenCalled();
    expect(locationsFind).not.toHaveBeenCalled();
  });

  it("routes to the locations table for entityType=location", async () => {
    const { ctx, locationsFind } = buildCtx(admin, { locations: [{ id: "l1" }] });
    const result = await entitiesMissingTranslation(
      null,
      { entityType: "location", locale: "ar" },
      ctx,
    );
    expect(result).toEqual(["l1"]);
    expect(locationsFind).toHaveBeenCalledOnce();
  });

  it("allows the pipeline role", async () => {
    const { ctx } = buildCtx(pipeline, { events: [] });
    await expect(
      entitiesMissingTranslation(null, { entityType: "event", locale: "ar" }, ctx),
    ).resolves.toEqual([]);
  });

  it("rejects a viewer with FORBIDDEN", async () => {
    const { ctx } = buildCtx(viewer);
    await expect(
      entitiesMissingTranslation(null, { entityType: "event", locale: "ar" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects an invalid entityType", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      entitiesMissingTranslation(null, { entityType: "bogus", locale: "ar" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects locale 'en' as canonical (case-insensitive)", async () => {
    const { ctx, eventsFind } = buildCtx(admin);
    await expect(
      entitiesMissingTranslation(null, { entityType: "event", locale: "EN" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(eventsFind).not.toHaveBeenCalled();
  });

  it("rejects an unsupported locale", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      entitiesMissingTranslation(null, { entityType: "event", locale: "de" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("Query.translationCoverage", () => {
  function buildCtx(
    user: User,
    opts: {
      grouped?: Array<{ entityType: string; locale: string; _count: { entityId: number } }>;
      eventCount?: number;
      crisisCount?: number;
      locationCount?: number;
      situationCount?: number;
    } = {},
  ) {
    const groupBy = vi.fn().mockResolvedValue(opts.grouped ?? []);
    const eventsCount = vi.fn().mockResolvedValue(opts.eventCount ?? 0);
    const crisesCount = vi.fn().mockResolvedValue(opts.crisisCount ?? 0);
    const locationsCount = vi.fn().mockResolvedValue(opts.locationCount ?? 0);
    const situationCount = vi.fn().mockResolvedValue(opts.situationCount ?? 0);
    const ctx = buildContext(user, {
      translations: { groupBy },
      events: { count: eventsCount },
      crises: { count: crisesCount },
      locations: { count: locationsCount },
      situationAnalysis: { count: situationCount },
    });
    return { ctx, groupBy };
  }

  it("admin-only: rejects the pipeline role", async () => {
    const { ctx } = buildCtx(pipeline);
    await expect(translationCoverage(null, {}, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("builds the full (event,crisis,location,situationAnalysis) x (target locale) matrix, skipping 'en'", async () => {
    const { ctx } = buildCtx(admin, {
      eventCount: 5,
      crisisCount: 2,
      locationCount: 9,
      situationCount: 4,
      grouped: [{ entityType: "event", locale: "ar", _count: { entityId: 3 } }],
    });
    const out = (await translationCoverage(null, {}, ctx)) as Array<{
      entityType: string;
      locale: string;
      canonicalCount: number;
      translatedCount: number;
    }>;

    // 4 entity types x 3 target locales (ar, fr, es — 'en' excluded) = 12 rows.
    expect(out).toHaveLength(12);
    expect(out.some((r) => r.locale === "en")).toBe(false);

    // The one grouped row is reflected; every other cell zero-filled.
    const eventAr = out.find((r) => r.entityType === "event" && r.locale === "ar");
    expect(eventAr).toEqual({
      entityType: "event",
      locale: "ar",
      canonicalCount: 5,
      translatedCount: 3,
    });
    const eventFr = out.find((r) => r.entityType === "event" && r.locale === "fr");
    expect(eventFr).toMatchObject({ canonicalCount: 5, translatedCount: 0 });
    const crisisAr = out.find((r) => r.entityType === "crisis" && r.locale === "ar");
    expect(crisisAr).toMatchObject({ canonicalCount: 2, translatedCount: 0 });
    const locationFr = out.find((r) => r.entityType === "location" && r.locale === "fr");
    expect(locationFr).toMatchObject({ canonicalCount: 9, translatedCount: 0 });
    const situationAr = out.find(
      (r) => r.entityType === "situationAnalysis" && r.locale === "ar",
    );
    expect(situationAr).toMatchObject({ canonicalCount: 4, translatedCount: 0 });
  });
});

describe("Mutation.upsertTranslations", () => {
  function buildCtx(
    user: User,
    opts: {
      entityExists?: boolean;
      entityType?: "event" | "crisis" | "location";
    } = {},
  ) {
    const { entityExists = true, entityType = "event" } = opts;
    const found = entityExists ? { id: "x1" } : null;
    const findUnique = vi.fn().mockResolvedValue(found);
    const eventsFind = vi.fn().mockResolvedValue(entityType === "event" ? found : null);
    const crisesFind = vi.fn().mockResolvedValue(entityType === "crisis" ? found : null);
    const locationsFind = vi.fn().mockResolvedValue(entityType === "location" ? found : null);

    const upsert = vi.fn((arg: unknown) => ({ __upsert: arg }));
    // $transaction receives the array of upsert "operations" (here, the
    // return values of the mocked upsert calls). Resolve them as-is.
    const $transaction = vi.fn(async (ops: unknown[]) => ops);

    // upsertTranslations clears any queued (re)translation rows after writing —
    // stub the queue delete so the resolver's drain-completion step is a no-op.
    const queueDeleteMany = vi.fn(async () => ({ count: 0 }));
    const ctx = buildContext(user, {
      events: { findUnique: eventsFind },
      crises: { findUnique: crisesFind },
      locations: { findUnique: locationsFind },
      translations: { upsert },
      translationQueue: { deleteMany: queueDeleteMany },
      $transaction,
    });
    return { ctx, upsert, $transaction, eventsFind, crisesFind, locationsFind, findUnique };
  }

  const goodLocaleEntry = {
    locale: "ar",
    data: { title: "x" },
    sourceHashes: { title: "abc" },
  };

  it("rejects a viewer with FORBIDDEN", async () => {
    const { ctx, $transaction } = buildCtx(viewer);
    await expect(
      upsertTranslations(
        null,
        { input: { entityType: "event", entityId: "e1", translations: [goodLocaleEntry] } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid entityType", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        { input: { entityType: "user", entityId: "e1", translations: [goodLocaleEntry] } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an empty translations array", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        { input: { entityType: "event", entityId: "e1", translations: [] } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects locale 'en' in a translation entry", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        {
          input: {
            entityType: "event",
            entityId: "e1",
            translations: [{ ...goodLocaleEntry, locale: "en" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an unsupported locale", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        {
          input: {
            entityType: "event",
            entityId: "e1",
            translations: [{ ...goodLocaleEntry, locale: "de" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects duplicate locales (case-insensitive)", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        {
          input: {
            entityType: "event",
            entityId: "e1",
            translations: [goodLocaleEntry, { ...goodLocaleEntry, locale: "AR" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects a non-object data field", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        {
          input: {
            entityType: "event",
            entityId: "e1",
            translations: [{ ...goodLocaleEntry, data: "nope" as unknown as Record<string, unknown> }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects a non-object sourceHashes field", async () => {
    const { ctx } = buildCtx(admin);
    await expect(
      upsertTranslations(
        null,
        {
          input: {
            entityType: "event",
            entityId: "e1",
            translations: [
              { ...goodLocaleEntry, sourceHashes: 42 as unknown as Record<string, string> },
            ],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("throws NOT_FOUND and skips the transaction when the entity is missing", async () => {
    const { ctx, $transaction } = buildCtx(admin, { entityExists: false });
    await expect(
      upsertTranslations(
        null,
        { input: { entityType: "event", entityId: "missing", translations: [goodLocaleEntry] } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("upserts one row per locale with the event FK + normalised payload and returns the summary", async () => {
    const { ctx, upsert, $transaction } = buildCtx(admin, { entityType: "event" });
    const result = await upsertTranslations(
      null,
      {
        input: {
          entityType: "EVENT",
          entityId: "e1",
          translations: [
            { locale: "AR", data: { t: "a" }, sourceHashes: { t: "h1" } },
            { locale: "fr", data: { t: "f" }, sourceHashes: { t: "h2" } },
          ],
        },
      },
      ctx,
    );

    expect($transaction).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledTimes(2);

    const first = upsert.mock.calls[0]![0] as UpsertArg;
    expect(first.where).toEqual({
      entityType_entityId_locale: { entityType: "event", entityId: "e1", locale: "ar" },
    });
    expect(first.create).toMatchObject({
      entityType: "event",
      entityId: "e1",
      eventId: "e1",
      locale: "ar",
      data: { t: "a" },
      sourceHashes: { t: "h1" },
    });
    // The event FK is set; the other typed FKs are absent.
    expect(first.create.crisisId).toBeUndefined();
    expect(first.create.locationId).toBeUndefined();
    expect(first.update).toMatchObject({ eventId: "e1", data: { t: "a" } });

    const second = upsert.mock.calls[1]![0] as UpsertArg;
    expect(second.where.entityType_entityId_locale.locale).toBe("fr");

    expect(result).toEqual({
      entityType: "event",
      entityId: "e1",
      locales: ["ar", "fr"],
    });
  });

  it("sets the crisisId FK when entityType is crisis", async () => {
    const { ctx, upsert } = buildCtx(admin, { entityType: "crisis" });
    await upsertTranslations(
      null,
      { input: { entityType: "crisis", entityId: "c1", translations: [goodLocaleEntry] } },
      ctx,
    );
    const arg = upsert.mock.calls[0]![0] as UpsertArg;
    expect(arg.create.crisisId).toBe("c1");
    expect(arg.create.eventId).toBeUndefined();
    expect(arg.create.locationId).toBeUndefined();
  });

  it("sets the locationId FK when entityType is location", async () => {
    const { ctx, upsert } = buildCtx(admin, { entityType: "location" });
    await upsertTranslations(
      null,
      { input: { entityType: "location", entityId: "l1", translations: [goodLocaleEntry] } },
      ctx,
    );
    const arg = upsert.mock.calls[0]![0] as UpsertArg;
    expect(arg.create.locationId).toBe("l1");
    expect(arg.create.eventId).toBeUndefined();
    expect(arg.create.crisisId).toBeUndefined();
  });

  it("allows the pipeline role", async () => {
    const { ctx, $transaction } = buildCtx(pipeline, { entityType: "event" });
    await upsertTranslations(
      null,
      { input: { entityType: "event", entityId: "e1", translations: [goodLocaleEntry] } },
      ctx,
    );
    expect($transaction).toHaveBeenCalledOnce();
  });
});
