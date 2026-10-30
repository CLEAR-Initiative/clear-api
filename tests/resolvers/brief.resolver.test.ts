/**
 * Unit tests for `brief.resolver.ts`.
 *
 * DB-free: `context.prisma.*` delegates are stubbed per test with `vi.fn()`,
 * and the email provider registry and `computeEntityStats` are mocked before
 * the resolver is imported, so nothing reaches SMTP or a database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

const send = vi.fn();
const sendBulk = vi.fn();

vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send, sendBulk })),
}));

// Counts run raw SQL; the db suite covers them (brief.db.test.ts).
const computeEntityStats = vi.fn(async () => ({ total: 0, buckets: [] }));
vi.mock("../../src/resolvers/pagination.resolver.js", () => ({ computeEntityStats }));

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

describe("a sent Brief is frozen", () => {
  const SENT = { ...DRAFT, status: "sent" };
  const ITEM = { id: "i1", briefId: "b1", kind: "event", brief: { status: "sent" } };
  const writes = {
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  };
  const ctx = () =>
    buildContext(ADMIN, {
      brief: { findUnique: vi.fn(async () => SENT), ...writes },
      briefItem: { findUnique: vi.fn(async () => ITEM), findMany: vi.fn(async () => [ITEM]), ...writes },
      $transaction: vi.fn(),
    });
  const M = briefResolvers.Mutation;
  const cases: Array<[string, (c: Context) => Promise<unknown>]> = [
    ["updateBrief", (c) => M.updateBrief(null, { id: "b1", input: { summary: "x" } }, c)],
    ["refreshBriefWindow", (c) => M.refreshBriefWindow(null, { id: "b1" }, c)],
    ["deleteBrief", (c) => M.deleteBrief(null, { id: "b1" }, c)],
    ["addBriefItem", (c) => M.addBriefItem(null, { briefId: "b1", kind: "event", entityId: "e1" }, c)],
    ["removeBriefItem", (c) => M.removeBriefItem(null, { itemId: "i1" }, c)],
    ["updateBriefItemNote", (c) => M.updateBriefItemNote(null, { itemId: "i1", note: "x" }, c)],
    ["reorderBriefItems", (c) => M.reorderBriefItems(null, { briefId: "b1", kind: "event", itemIds: ["i1"] }, c)],
  ];

  it.each(cases)("%s is BAD_USER_INPUT and writes nothing", async (_name, call) => {
    Object.values(writes).forEach((w) => w.mockReset());
    const c = ctx();
    const err = await call(c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe("BAD_USER_INPUT");
    expect((err as GraphQLError).message).toBe("Brief already sent");
    Object.values(writes).forEach((w) => expect(w).not.toHaveBeenCalled());
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a draft write that loses the race to a send is rejected too", async () => {
    const c = buildContext(ADMIN, {
      brief: {
        findUnique: vi.fn(async () => DRAFT),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    expect(await codeOf(M.updateBrief(null, { id: "b1", input: { title: "New" } }, c))).toBe("BAD_USER_INPUT");
  });
});

describe("reorderBriefItems", () => {
  it("rejects a list that isn't exactly the group", async () => {
    const c = buildContext(ADMIN, {
      brief: { findUnique: vi.fn(async () => DRAFT) },
      briefItem: { findMany: vi.fn(async () => [{ id: "i1" }, { id: "i2" }]) },
    });
    for (const itemIds of [["i1"], ["i1", "i1"], ["i1", "i3"], ["i1", "i2", "i3"]]) {
      expect(
        await codeOf(briefResolvers.Mutation.reorderBriefItems(null, { briefId: "b1", kind: "event", itemIds }, c)),
      ).toBe("BAD_USER_INPUT");
    }
  });
});

describe("updateBrief", () => {
  it("rejects a blank title", async () => {
    const c = buildContext(ADMIN, { brief: { findUnique: vi.fn(async () => DRAFT) } });
    expect(
      await codeOf(briefResolvers.Mutation.updateBrief(null, { id: "b1", input: { title: "  " } }, c)),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("Brief.counts", () => {
  it("returns the frozen counts of a sent Brief without querying", async () => {
    const snapshot = { signal: { total: 3 }, event: { total: 2 }, alert: { total: 1 } };
    const $queryRaw = vi.fn();
    const ctx = buildContext(ADMIN, { $queryRaw });
    const counts = await briefResolvers.Brief.counts(
      { ...DRAFT, status: "sent", countsSnapshot: snapshot },
      {},
      ctx,
    );
    expect(counts).toBe(snapshot);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("Recipient lists", () => {
  it("adds an address lower-cased, with a fresh unguessable token", async () => {
    const upsert = vi.fn(async (a) => a.create);
    const ctx = buildContext(ADMIN, {
      recipientList: { findUnique: vi.fn(async () => ({ id: "l1" })) },
      recipientListMember: { upsert },
    });
    const m = await briefResolvers.Mutation.addRecipientListMember(
      null,
      { listId: "l1", email: "  Andi@Example.ORG " },
      ctx,
    );
    expect(m.email).toBe("andi@example.org");
    expect(upsert.mock.calls[0][0].where).toEqual({ listId_email: { listId: "l1", email: "andi@example.org" } });
    expect(upsert.mock.calls[0][0].update).toEqual({});
    expect(m.unsubscribeToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("rejects something that isn't an email address", async () => {
    const ctx = buildContext(ADMIN, {});
    for (const email of ["", "andi", "andi@", "@example.org", "a b@example.org"]) {
      expect(
        await codeOf(briefResolvers.Mutation.addRecipientListMember(null, { listId: "l1", email }, ctx)),
      ).toBe("BAD_USER_INPUT");
    }
  });

  it("is NOT_FOUND for an unknown list", async () => {
    const ctx = buildContext(ADMIN, { recipientList: { findUnique: vi.fn(async () => null) } });
    expect(
      await codeOf(
        briefResolvers.Mutation.addRecipientListMember(null, { listId: "nope", email: "a@example.org" }, ctx),
      ),
    ).toBe("NOT_FOUND");
  });

  it("rejects a blank list name", async () => {
    const ctx = buildContext(ADMIN, {});
    expect(await codeOf(briefResolvers.Mutation.createRecipientList(null, { name: "  " }, ctx))).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("sendBrief", () => {
  const members = [
    { email: "james@example.org", unsubscribeToken: "tok-james" },
    { email: "andi@example.org", unsubscribeToken: "tok-andi" },
  ];

  function sendCtx(over: Record<string, unknown> = {}) {
    const tx = {
      brief: { updateMany: vi.fn(async () => ({ count: 1 })) },
      briefItem: { findMany: vi.fn(async () => []), update: vi.fn() },
      alerts: { findUnique: vi.fn() },
      events: { findUnique: vi.fn() },
      signals: { findUnique: vi.fn() },
    };
    const memberFind = vi.fn(async () => members);
    const briefUpdate = vi.fn();
    const ctx = buildContext(ADMIN, {
      brief: {
        findUnique: vi.fn(async () => DRAFT),
        findUniqueOrThrow: vi.fn(async () => ({ ...DRAFT, status: "sent", items: [] })),
        update: briefUpdate,
      },
      recipientList: { findUnique: vi.fn(async () => ({ id: "l1" })) },
      recipientListMember: { findMany: memberFind },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      ...over,
    });
    return { ctx, tx, memberFind, briefUpdate };
  }

  it("emails only members who haven't unsubscribed, each with their own unsubscribe link", async () => {
    sendBulk.mockImplementation(async (msgs: unknown[]) => msgs.map(() => true));
    const { ctx, tx, memberFind, briefUpdate } = sendCtx();

    expect(await briefResolvers.Mutation.sendBrief(null, { id: "b1", recipientListId: "l1" }, ctx)).toEqual({
      sent: 2,
      failed: 0,
    });
    expect(memberFind.mock.calls[0][0].where).toEqual({ listId: "l1", unsubscribedAt: null });
    const msgs = sendBulk.mock.calls[0][0] as Array<{ to: string; textBody: string; htmlBody: string; subject: string }>;
    expect(msgs.map((m) => m.to)).toEqual(["james@example.org", "andi@example.org"]);
    expect(msgs[0].htmlBody).toContain("/briefs/unsubscribe?token=tok-james");
    expect(msgs[1].htmlBody).toContain("/briefs/unsubscribe?token=tok-andi");
    expect(msgs[0].htmlBody).not.toContain("tok-andi");
    expect(msgs[0].subject).not.toContain("[TEST]");

    const freeze = tx.brief.updateMany.mock.calls[0][0];
    expect(freeze.where).toEqual({ id: "b1", status: "draft" });
    expect(freeze.data).toMatchObject({ status: "sent", sentById: "admin-1", sentToListId: "l1" });
    expect(freeze.data.countsSnapshot).toHaveProperty("signal");
    expect(briefUpdate).toHaveBeenCalledWith({ where: { id: "b1" }, data: { sentCount: 2, failedCount: 0 } });
  });

  it("counts provider refusals as failed, and a provider crash as all failed, without retrying", async () => {
    sendBulk.mockImplementation(async () => [true, false]);
    let { ctx } = sendCtx();
    expect(await briefResolvers.Mutation.sendBrief(null, { id: "b1", recipientListId: "l1" }, ctx)).toEqual({
      sent: 1,
      failed: 1,
    });
    expect(sendBulk).toHaveBeenCalledTimes(1);

    sendBulk.mockReset();
    sendBulk.mockRejectedValue(new Error("smtp down"));
    ({ ctx } = sendCtx());
    expect(await briefResolvers.Mutation.sendBrief(null, { id: "b1", recipientListId: "l1" }, ctx)).toEqual({
      sent: 0,
      failed: 2,
    });
    expect(sendBulk).toHaveBeenCalledTimes(1);
  });

  it("emails no one when another send froze the Brief first", async () => {
    const { ctx, tx } = sendCtx();
    tx.brief.updateMany.mockResolvedValue({ count: 0 });
    expect(await codeOf(briefResolvers.Mutation.sendBrief(null, { id: "b1", recipientListId: "l1" }, ctx))).toBe(
      "BAD_USER_INPUT",
    );
    expect(sendBulk).not.toHaveBeenCalled();
  });

  it("refuses a list with no one to send to, before freezing", async () => {
    const { ctx } = sendCtx({ recipientListMember: { findMany: vi.fn(async () => []) } });
    expect(await codeOf(briefResolvers.Mutation.sendBrief(null, { id: "b1", recipientListId: "l1" }, ctx))).toBe(
      "BAD_USER_INPUT",
    );
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });
});
