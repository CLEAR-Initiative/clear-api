/** Unit tests (mocked Prisma) for Query.eventMembers and Mutation.setEventAggregates:
 *  auth and the args passed to Prisma, not SQL. */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import type { Context } from "../../src/context.js";

function ctx(prisma: unknown, role: string | null = "admin"): Context {
  return {
    prisma,
    user: role ? ({ id: "u1", role } as unknown) : null,
    session: null,
    authMethod: role ? "session" : null,
    locale: "en",
  } as Context;
}

// ─── eventMembers ────────────────────────────────────────────────────────────

describe("eventMembers", () => {
  const q = signalResolvers.Query.eventMembers;

  it("API-U-60 filters live members of the event, newest first, no take when first is absent", async () => {
    const findMany = vi.fn(async () => []);
    await q({}, { eventId: "e1" }, ctx({ signals: { findMany } }));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { retracted: false, signalEvents: { some: { eventId: "e1" } } },
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    });
    expect(findMany.mock.calls[0][0]).not.toHaveProperty("take");
    // not filtered by isDummy or status
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("isDummy");
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("status");
  });

  it.each([[5, 5], [1, 1], [0, 1], [-3, 1], [100000, 100000]])("API-U-60 first=%s -> take=%s", async (first, take) => {
    const findMany = vi.fn(async () => []);
    await q({}, { eventId: "e1", first }, ctx({ signals: { findMany } }));
    expect(findMany.mock.calls[0][0].take).toBe(take);
  });

  it("first: null means uncapped", async () => {
    const findMany = vi.fn(async () => []);
    await q({}, { eventId: "e1", first: null }, ctx({ signals: { findMany } }));
    expect(findMany.mock.calls[0][0]).not.toHaveProperty("take");
  });

  it("API-U-61 roles: admin and pipeline ok; viewer and anonymous rejected before the DB", async () => {
    for (const role of ["admin", "pipeline"]) {
      const findMany = vi.fn(async () => []);
      await q({}, { eventId: "e1" }, ctx({ signals: { findMany } }, role));
      expect(findMany).toHaveBeenCalled();
    }
    for (const role of ["viewer", null]) {
      const findMany = vi.fn();
      await expect(q({}, { eventId: "e1" }, ctx({ signals: { findMany } }, role))).rejects.toBeInstanceOf(GraphQLError);
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("API-U-62 unknown event -> [] (no error)", async () => {
    const findMany = vi.fn(async () => []);
    await expect(q({}, { eventId: "nope" }, ctx({ signals: { findMany } }))).resolves.toEqual([]);
  });
});

// ─── setEventAggregates ──────────────────────────────────────────────────────

function eventPrisma(existing: unknown = { id: "e1" }) {
  const findUnique = vi.fn(async () => existing);
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "e1", ...args.data }));
  const signalEvents = {
    create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    delete: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(),
  };
  return { events: { findUnique, update }, signalEvents };
}

const set = eventResolvers.Mutation.setEventAggregates;
const dataOf = (p: ReturnType<typeof eventPrisma>) =>
  (p.events.update.mock.calls[0][0] as unknown as { where: unknown; data: Record<string, unknown> });

describe("setEventAggregates", () => {
  it("API-U-64 writes explicit nulls through and rank as given", async () => {
    const p = eventPrisma();
    await set({}, {
      id: "e1",
      input: {
        severity: null, casualties: null, populationAffected: null, populationDisplaced: null,
        title: null, description: null, rewriteMembersHash: null, rank: 0,
      },
    }, ctx(p));
    const { where, data } = dataOf(p);
    expect(where).toEqual({ id: "e1" });
    for (const k of ["severity", "casualties", "populationAffected", "populationDisplaced", "title", "description", "rewriteMembersHash"]) {
      expect(data).toHaveProperty(k, null);
    }
    expect(data.rank).toBe(0);
  });

  it("API-U-65 absent keys are undefined in data (Prisma ignores them), not null", async () => {
    const p = eventPrisma();
    await set({}, { id: "e1", input: { rank: 2.5, severity: 3 } }, ctx(p));
    const { data } = dataOf(p);
    expect(data.severity).toBe(3);
    expect(data.rank).toBe(2.5);
    for (const k of ["casualties", "populationAffected", "populationDisplaced", "title", "description", "rewriteMembersHash"]) {
      expect(data[k]).toBeUndefined();
    }
    // Prisma drops undefined keys on serialisation, so these are "unchanged"
    expect(JSON.parse(JSON.stringify(data))).toEqual({ severity: 3, rank: 2.5 });
  });

  it("API-U-65 title/description left alone when only aggregates are given (LLM-failure path)", async () => {
    const p = eventPrisma();
    await set({}, { id: "e1", input: { rank: 1, severity: 4, casualties: 10 } }, ctx(p));
    const { data } = dataOf(p);
    expect(data.title).toBeUndefined();
    expect(data.description).toBeUndefined();
  });

  it("API-U-66 populationAffected/Displaced strings become BigInt, including > Number.MAX_SAFE_INTEGER", async () => {
    const p = eventPrisma();
    const huge = "9007199254740993"; // MAX_SAFE_INTEGER + 2, not representable as a double
    await set({}, { id: "e1", input: { rank: 1, populationAffected: huge, populationDisplaced: "0" } }, ctx(p));
    const { data } = dataOf(p);
    expect(typeof data.populationAffected).toBe("bigint");
    expect(data.populationAffected).toBe(9007199254740993n);
    expect((data.populationAffected as bigint).toString()).toBe(huge);
    expect(data.populationDisplaced).toBe(0n);
  });

  it("API-U-66 null BigInt input is passed through as null (clear), absent stays undefined", async () => {
    const p = eventPrisma();
    await set({}, { id: "e1", input: { rank: 1, populationAffected: null } }, ctx(p));
    const { data } = dataOf(p);
    expect(data.populationAffected).toBeNull();
    expect(data.populationDisplaced).toBeUndefined();
  });

  // "", " 5 " and "0x10" are accepted by BigInt() itself (as 0n, 5n, 16n) and must not be.
  it.each(["abc", "1.5", "12abc", "1e3", "", " 5 ", "0x10", "+5", "5n"])("API-U-66 invalid BigInt string %j -> BAD_USER_INPUT and no write", async (bad) => {
    const p = eventPrisma();
    await expect(
      set({}, { id: "e1", input: { rank: 1, populationAffected: bad } }, ctx(p)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      set({}, { id: "e1", input: { rank: 1, populationDisplaced: bad } }, ctx(p)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(p.events.update).not.toHaveBeenCalled();
  });

  it("API-U-68 unknown event -> NOT_FOUND, no update", async () => {
    const p = eventPrisma(null);
    await expect(set({}, { id: "nope", input: { rank: 1 } }, ctx(p))).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(p.events.update).not.toHaveBeenCalled();
  });

  it("API-U-68 roles: admin and pipeline ok; viewer and anonymous rejected before the DB", async () => {
    for (const role of ["admin", "pipeline"]) {
      const p = eventPrisma();
      await set({}, { id: "e1", input: { rank: 1 } }, ctx(p, role));
      expect(p.events.update).toHaveBeenCalled();
    }
    for (const role of ["viewer", null]) {
      const p = eventPrisma();
      await expect(set({}, { id: "e1", input: { rank: 1 } }, ctx(p, role))).rejects.toBeInstanceOf(GraphQLError);
      expect(p.events.findUnique).not.toHaveBeenCalled();
      expect(p.events.update).not.toHaveBeenCalled();
    }
  });

  it("API-U-68 rewriteMembersHash is written", async () => {
    const p = eventPrisma();
    const out = await set({}, { id: "e1", input: { rank: 1, rewriteMembersHash: "abc123" } }, ctx(p));
    expect(dataOf(p).data.rewriteMembersHash).toBe("abc123");
    expect(out).toMatchObject({ id: "e1", rewriteMembersHash: "abc123" });
  });

  it("API-U-69 only events.update runs: no signalEvents writes, no validTo", async () => {
    const p = eventPrisma();
    await set({}, { id: "e1", input: { rank: 1, severity: 2, title: "t" } }, ctx(p));
    for (const fn of Object.values(p.signalEvents)) expect(fn).not.toHaveBeenCalled();
    expect(p.events.update).toHaveBeenCalledTimes(1);
    expect(dataOf(p).data).not.toHaveProperty("validTo");
    expect(Object.keys(dataOf(p).data).sort()).toEqual([
      "casualties", "description", "populationAffected", "populationDisplaced",
      "rank", "rewriteMembersHash", "severity", "title",
    ]);
  });
});
