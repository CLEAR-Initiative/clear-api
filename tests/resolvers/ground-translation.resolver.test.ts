/**
 * On-demand translation of hotline messages (#627):
 * requestGroundMessageTranslation, GroundMessage.translation(locale), and
 * the pipeline drain's groundMessageForTranslation fetch.
 *
 * DB-FREE: `context.prisma` stubs only the delegates the resolvers touch.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "../../src/context.js";

vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrls: vi.fn(async () => []),
  uploadBufferToS3: vi.fn(),
}));

vi.mock("../../src/resolvers/signal.resolver.js", () => ({
  signalResolvers: { Mutation: { createSignal: vi.fn() } },
}));

import { groundResolvers } from "../../src/resolvers/ground.resolver.js";

type User = { id: string; role: string } | null;

const ADMIN: User = { id: "admin1", role: "admin" };
// The ground inbox is admin-or-ERM now (analyst no longer grants ground access).
// This caller is a global `member` carrying the emergency_response_manager TEAM
// role on team-1, which owns the message's source (see the stub below).
const ERM: User = { id: "a1", role: "member" };
const PIPELINE: User = { id: "machine", role: "pipeline" };
// A plain global member with no ERM membership.
const MEMBER: User = { id: "v1", role: "member" };

const { requestGroundMessageTranslation } = groundResolvers.Mutation;
const { groundMessageForTranslation } = groundResolvers.Query;
const { translation } = groundResolvers.GroundMessage;

const MESSAGE = { id: "m1", text: "قصف على السوق الرئيسي" };

/** Prisma stub for one message and its translation state. `order` records
 * which table each state read hit, to pin the queue-before-overlay order. */
function stub(opts: {
  /** groundSourceId defaults to src-1, the ERM's team source. */
  message?: { id: string; text: string; groundSourceId?: string } | null;
  queued?: boolean;
  translated?: string | null;
}) {
  const order: string[] = [];
  const prisma = {
    groundMessages: {
      findUnique: vi.fn(async () => {
        const message = opts.message === undefined ? MESSAGE : opts.message;
        return message && { groundSourceId: "src-1", ...message };
      }),
    },
    translationQueue: {
      findUnique: vi.fn(async () => {
        order.push("queue");
        return opts.queued ? { id: "q1" } : null;
      }),
      upsert: vi.fn(async () => ({ id: "q1" })),
    },
    translations: {
      findUnique: vi.fn(async () => {
        order.push("overlay");
        return opts.translated != null ? { data: { text: opts.translated } } : null;
      }),
    },
    teamMembers: {
      // The inbox gate asks for the user's ERM teams: only id "a1" has one.
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => (where.userId === "a1" ? [{ teamId: "team-1" }] : [])),
    },
    // team-1's sources: the one every message here comes from.
    groundSources: { findMany: vi.fn(async () => [{ id: "src-1" }]) },
  };
  return { prisma, order };
}

function ctx(user: User, prisma: Record<string, unknown>): Context {
  return {
    prisma: prisma as unknown as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

describe("requestGroundMessageTranslation", () => {
  it("queues the (groundMessage, id, locale) pair and reports it queued", async () => {
    const { prisma } = stub({});
    const result = await requestGroundMessageTranslation(
      null,
      { messageId: "m1", locale: "EN" },
      ctx(ERM, prisma),
    );

    expect(result).toEqual({ locale: "en", status: "queued", text: null });
    expect(prisma.translationQueue.upsert).toHaveBeenCalledWith({
      where: {
        entityType_entityId_locale: { entityType: "groundMessage", entityId: "m1", locale: "en" },
      },
      create: { entityType: "groundMessage", entityId: "m1", locale: "en" },
      update: {}, // idempotent — a repeat keeps its place in the drain
    });
  });

  it("returns a ready translation without re-queueing", async () => {
    const { prisma } = stub({ translated: "Shelling at the main market" });
    const result = await requestGroundMessageTranslation(
      null,
      { messageId: "m1", locale: "en" },
      ctx(ADMIN, prisma),
    );

    expect(result).toEqual({ locale: "en", status: "ready", text: "Shelling at the main market" });
    expect(prisma.translationQueue.upsert).not.toHaveBeenCalled();
  });

  it("re-queues after the drain gave up (unavailable)", async () => {
    const { prisma } = stub({ queued: false, translated: null });
    const result = await requestGroundMessageTranslation(
      null,
      { messageId: "m1", locale: "fr" },
      ctx(ERM, prisma),
    );

    expect(result.status).toBe("queued");
    expect(prisma.translationQueue.upsert).toHaveBeenCalledTimes(1);
  });

  it("has nothing to translate for a media-only message", async () => {
    const { prisma } = stub({ message: { id: "m1", text: "   " } });
    const result = await requestGroundMessageTranslation(
      null,
      { messageId: "m1", locale: "en" },
      ctx(ERM, prisma),
    );

    expect(result).toEqual({ locale: "en", status: "unavailable", text: null });
    expect(prisma.translationQueue.upsert).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for an unknown message", async () => {
    const { prisma } = stub({ message: null });
    await expect(
      requestGroundMessageTranslation(null, { messageId: "nope", locale: "en" }, ctx(ERM, prisma)),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("throws NOT_FOUND for another team's message, before any translation read or queue write", async () => {
    const { prisma, order } = stub({ message: { ...MESSAGE, groundSourceId: "src-other-team" } });
    await expect(
      requestGroundMessageTranslation(null, { messageId: "m1", locale: "en" }, ctx(ERM, prisma)),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(order).toEqual([]);
    expect(prisma.translationQueue.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unsupported locale before touching the DB", async () => {
    const { prisma } = stub({});
    await expect(
      requestGroundMessageTranslation(null, { messageId: "m1", locale: "de" }, ctx(ERM, prisma)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(prisma.groundMessages.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain member", MEMBER],
    ["pipeline", PIPELINE],
    ["anonymous", null],
  ])("rejects a %s caller", async (_name, user) => {
    const { prisma } = stub({});
    await expect(
      requestGroundMessageTranslation(null, { messageId: "m1", locale: "en" }, ctx(user, prisma)),
    ).rejects.toThrow();
    expect(prisma.translationQueue.upsert).not.toHaveBeenCalled();
  });
});

describe("GroundMessage.translation", () => {
  it("is ready once the overlay row exists, with its text", async () => {
    const { prisma } = stub({ translated: "Shelling at the main market" });
    await expect(translation(MESSAGE, { locale: "en" }, ctx(ERM, prisma))).resolves.toEqual({
      locale: "en",
      status: "ready",
      text: "Shelling at the main market",
    });
    expect(prisma.translations.findUnique).toHaveBeenCalledWith({
      where: { groundMessageId_locale: { groundMessageId: "m1", locale: "en" } },
      select: { data: true },
    });
  });

  it("is queued while the queue row exists and no overlay is written", async () => {
    const { prisma } = stub({ queued: true });
    await expect(translation(MESSAGE, { locale: "en" }, ctx(ERM, prisma))).resolves.toEqual({
      locale: "en",
      status: "queued",
      text: null,
    });
  });

  it("is unavailable when neither exists", async () => {
    const { prisma } = stub({});
    const result = await translation(MESSAGE, { locale: "ar" }, ctx(ERM, prisma));
    expect(result.status).toBe("unavailable");
  });

  it("reads the queue before the overlay, so a drain finishing mid-read is never unavailable", async () => {
    const { prisma, order } = stub({ queued: true, translated: "done" });
    const result = await translation(MESSAGE, { locale: "en" }, ctx(ERM, prisma));
    expect(order).toEqual(["queue", "overlay"]);
    expect(result.status).toBe("ready");
  });

  it("ignores an overlay row without a text string", async () => {
    const { prisma } = stub({ queued: true });
    prisma.translations.findUnique.mockResolvedValueOnce({ data: { title: "x" } } as never);
    const result = await translation(MESSAGE, { locale: "en" }, ctx(ERM, prisma));
    expect(result.status).toBe("queued");
  });

  it("rejects an unsupported locale", async () => {
    const { prisma } = stub({});
    await expect(
      translation(MESSAGE, { locale: "xx" }, ctx(ERM, prisma)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("groundMessageForTranslation (pipeline contract)", () => {
  it("returns text + language only — no sender identity", async () => {
    const findUnique = vi.fn(async () => ({ id: "m1", text: "…", language: "ar" }));
    const result = await groundMessageForTranslation(
      null,
      { id: "m1" },
      ctx(PIPELINE, { groundMessages: { findUnique } }),
    );
    expect(result).toEqual({ id: "m1", text: "…", language: "ar" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "m1" },
      select: { id: true, text: true, language: true },
    });
  });

  it("is admin/pipeline only", async () => {
    const findUnique = vi.fn();
    await expect(
      groundMessageForTranslation(null, { id: "m1" }, ctx(ERM, { groundMessages: { findUnique } })),
    ).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
