/**
 * Unit tests for `brief.resolver.ts`.
 *
 * DB-free: `context.prisma.*` delegates are stubbed per test with `vi.fn()`,
 * and the email provider registry is mocked before the resolver is imported,
 * so nothing reaches SMTP or a database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

const send = vi.fn();
const sendBulk = vi.fn();

vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send, sendBulk })),
}));

const { briefResolvers } = await import("../../src/resolvers/brief.resolver.js");
import type { Context } from "../../src/context.js";

type User = { id: string; role: string; email?: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const ADMIN = { id: "admin-1", role: "admin", email: "admin@example.org" };

async function codeOf(p: unknown): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions.code as string;
  }
  return undefined;
}

const DRAFT = {
  id: "b1",
  cadence: "daily",
  status: "draft",
  title: "Daily Brief, Sudan",
  locationId: "loc-sd",
  locationName: "Sudan",
  windowStart: new Date("2026-10-29T08:00:00Z"),
  windowEnd: new Date("2026-10-30T08:00:00Z"),
  summary: "",
  closingNotes: "",
  countsSnapshot: null,
};

beforeEach(() => {
  send.mockReset();
  sendBulk.mockReset();
});

describe("admin gate", () => {
  // Every resolver function on every Brief-owned type, so a resolver added
  // later is covered without touching this test.
  const all = Object.entries(briefResolvers).flatMap(([type, fields]) =>
    Object.entries(fields as Record<string, (...a: unknown[]) => unknown>).map(
      ([name, fn]) => [`${type}.${name}`, fn] as const,
    ),
  );

  it.each(all)("%s is FORBIDDEN for a member", async (_name, fn) => {
    const ctx = buildContext({ id: "u1", role: "member" });
    expect(await codeOf((async () => fn({ id: "b1", snapshot: {} }, { id: "b1", input: {} }, ctx))())).toBe(
      "FORBIDDEN",
    );
  });

  it.each(all)("%s is UNAUTHENTICATED without a session", async (_name, fn) => {
    const ctx = buildContext(null);
    expect(await codeOf((async () => fn({ id: "b1", snapshot: {} }, { id: "b1", input: {} }, ctx))())).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("createBrief", () => {
  it("windows the last 24 hours and defaults the title", async () => {
    const create = vi.fn(async ({ data }) => ({ id: "b1", ...data }));
    const ctx = buildContext(ADMIN, {
      locations: { findUnique: vi.fn(async () => ({ name: "Sudan", level: 0 })) },
      brief: { create },
    });
    const before = Date.now();
    await briefResolvers.Mutation.createBrief(null, { input: { cadence: "daily", locationId: "loc-sd" } }, ctx);
    const data = create.mock.calls[0][0].data;
    expect(data.title).toBe("Daily Brief, Sudan");
    expect(data.locationName).toBe("Sudan");
    expect(data.createdById).toBe("admin-1");
    expect(data.windowEnd.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.windowEnd.getTime() - data.windowStart.getTime()).toBe(24 * 3600 * 1000);
  });

  it("rejects an area below district level", async () => {
    const ctx = buildContext(ADMIN, {
      locations: { findUnique: vi.fn(async () => ({ name: "Some point", level: 4 })) },
    });
    expect(
      await codeOf(
        briefResolvers.Mutation.createBrief(null, { input: { cadence: "weekly", locationId: "pt" } }, ctx),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("sendBriefTest", () => {
  it("emails only the caller, marked [TEST], and changes nothing", async () => {
    send.mockResolvedValue(true);
    const update = vi.fn();
    const ctx = buildContext(ADMIN, {
      brief: {
        findUnique: vi.fn(async () => ({ ...DRAFT, items: [] })),
        update,
        updateMany: update,
      },
      briefItem: { findMany: vi.fn(async () => []) },
    });

    expect(await briefResolvers.Mutation.sendBriefTest(null, { id: "b1" }, ctx)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@example.org");
    expect(send.mock.calls[0][0].subject).toMatch(/^\[TEST\] /);
    expect(sendBulk).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("addBriefItem", () => {
  it("is rejected on a sent Brief", async () => {
    const ctx = buildContext(ADMIN, {
      brief: { findUnique: vi.fn(async () => ({ ...DRAFT, status: "sent" })) },
    });
    expect(
      await codeOf(
        briefResolvers.Mutation.addBriefItem(null, { briefId: "b1", kind: "event", entityId: "e1" }, ctx),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});
