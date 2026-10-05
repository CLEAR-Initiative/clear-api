/**
 * Schema/contract tests for the retraction + recompute surface through a real ApolloServer.
 * Query strings mirror clear-pipeline's providers/clear_api.py; keep them in sync.
 * DB-FREE: Prisma is a `vi.fn()` mock.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

function buildContext(prisma: unknown, role = "pipeline"): Context {
  return {
    prisma, user: { id: "u", role }, session: null, authMethod: "session", locale: "en",
  } as unknown as Context;
}

async function exec(
  query: string,
  variables: Record<string, unknown> | undefined,
  prisma: unknown = {},
) {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: buildContext(prisma) },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected single result, got ${response.body.kind}`);
  return response.body.singleResult;
}

const SIGNAL_ROW = {
  id: "s1", status: "NEEDS_RECOMPUTE", retracted: true, revision: 4, contentHash: "h",
  externalId: "ext", url: "https://x", publishedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("signal recompute schema contract", () => {
  it("API-S-04 SignalStatus lists exactly NEW, PROCESSED, FAILED, NEEDS_RECOMPUTE", async () => {
    const r = await exec(`{ __type(name: "SignalStatus") { enumValues { name } } }`, undefined);
    expect(r.errors).toBeUndefined();
    const names = (r.data as { __type: { enumValues: { name: string }[] } }).__type.enumValues.map((v) => v.name);
    expect([...names].sort()).toEqual(["FAILED", "NEEDS_RECOMPUTE", "NEW", "PROCESSED"]);
  });

  it("API-S-04 pendingRecomputes serialises NEEDS_RECOMPUTE", async () => {
    const findMany = vi.fn(async () => [SIGNAL_ROW]);
    const r = await exec(
      `query($first: Int) { pendingRecomputes(first: $first) { id status revision retracted contentHash externalId url } }`,
      { first: 10 },
      { signals: { findMany } },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.pendingRecomputes).toEqual([
      { id: "s1", status: "NEEDS_RECOMPUTE", revision: 4, retracted: true, contentHash: "h", externalId: "ext", url: "https://x" },
    ]);
  });

  it("API-S-05 the old MarkSignalsProcessed($ids,$status) still validates and runs", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const r = await exec(
      `mutation MarkSignalsProcessed($ids: [String!], $status: SignalStatus) {
         markSignalsProcessed(ids: $ids, status: $status) }`,
      { ids: ["a", "b"], status: "FAILED" },
      { signals: { updateMany } },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.markSignalsProcessed).toBe(2);
  });

  it("API-S-06 the new $items:[SignalRevisionInput!] validates and runs via $transaction", async () => {
    const updateMany = vi.fn(() => ({ count: 1 }));
    const $transaction = vi.fn(async (ops: { count: number }[]) => ops);
    const r = await exec(
      `mutation MarkSignalsProcessed($items: [SignalRevisionInput!], $status: SignalStatus) {
         markSignalsProcessed(items: $items, status: $status) }`,
      { items: [{ id: "a", revision: 1 }, { id: "b", revision: 2 }], status: "PROCESSED" },
      { signals: { updateMany }, $transaction },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.markSignalsProcessed).toBe(2);
  });

  it("API-S-06 a SignalRevisionInput missing revision fails validation", async () => {
    const r = await exec(
      `mutation($items: [SignalRevisionInput!]) { markSignalsProcessed(items: $items) }`,
      { items: [{ id: "a" }] },
    );
    expect(r.errors?.[0].message).toMatch(/revision/);
  });

  it("API-S-06 markSignalsProcessed with NEEDS_RECOMPUTE status is schema-valid but rejected by the resolver", async () => {
    const r = await exec(
      `mutation($ids: [String!], $status: SignalStatus) { markSignalsProcessed(ids: $ids, status: $status) }`,
      { ids: ["a"], status: "NEEDS_RECOMPUTE" },
      { signals: { updateMany: vi.fn() } },
    );
    expect(r.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("API-S-07 both the old and the new PENDING_SIGNALS selections validate", async () => {
    const findMany = vi.fn(async () => [SIGNAL_ROW]);
    const oldQ = `query($first: Int, $source: String) { pendingSignals(first: $first, source: $source) { id rawData } }`;
    // rawData is not exposed on Signal: the OLD string must be checked without it
    const oldOk = `query($first: Int, $source: String) { pendingSignals(first: $first, source: $source) { id status url title } }`;
    const newQ = `query($first: Int, $source: String) { pendingSignals(first: $first, source: $source) { id status revision retracted url } }`;
    for (const q of [oldOk, newQ]) {
      const r = await exec(q, { first: 5, source: "idmc" }, { signals: { findMany } });
      expect(r.errors).toBeUndefined();
    }
    const bad = await exec(oldQ, { first: 5 }, { signals: { findMany } });
    expect(bad.errors?.[0].message).toMatch(/Cannot query field "rawData"/);
  });

  it("API-S-08 EVENT_MEMBERS validates; selecting rawData fails with Cannot query field", async () => {
    const findMany = vi.fn(async () => [SIGNAL_ROW]);
    const ok = await exec(
      `query($eventId: String!, $first: Int) { eventMembers(eventId: $eventId, first: $first) {
         id externalId url severity casualties publishedAt retracted revision contentHash } }`,
      { eventId: "e1", first: 50 },
      { signals: { findMany } },
    );
    expect(ok.errors).toBeUndefined();
    const bad = await exec(
      `query($eventId: String!) { eventMembers(eventId: $eventId) { id rawData } }`,
      { eventId: "e1" },
      { signals: { findMany } },
    );
    expect(bad.errors?.[0].message).toMatch(/Cannot query field "rawData"/);
    expect(findMany).toHaveBeenCalledTimes(1); // only the valid query reached the resolver
  });

  it("API-S-09 createSignal selection `contentHash retracted` validates", async () => {
    const r = await exec(
      `mutation($input: CreateSignalInput!) { createSignal(input: $input) { id contentHash retracted } }`,
      { input: { sourceId: "s", externalId: "e", rawData: {}, publishedAt: "2026-01-01T00:00:00Z" } },
      {},
    );
    // validation passes: any error is a resolver/runtime one (role, missing source), never a schema one
    expect((r.errors ?? []).map((e) => e.extensions?.code)).not.toContain("GRAPHQL_VALIDATION_FAILED");
    expect((r.errors ?? []).map((e) => e.extensions?.code)).not.toContain("BAD_USER_INPUT");
  });

  it("API-S-10 setEventAggregates without rank fails validation; with rank it runs", async () => {
    const bad = await exec(
      `mutation($id: String!, $input: EventAggregatesInput!) { setEventAggregates(id: $id, input: $input) { id } }`,
      { id: "e1", input: { severity: 3 } },
    );
    expect(bad.errors?.[0].message).toMatch(/rank/);

    const findUnique = vi.fn(async () => ({ id: "e1" }));
    const update = vi.fn(async () => ({ id: "e1", rewriteMembersHash: "hh", rank: 1, populationAffected: null }));
    const ok = await exec(
      `mutation($id: String!, $input: EventAggregatesInput!) {
         setEventAggregates(id: $id, input: $input) { id rewriteMembersHash } }`,
      { id: "e1", input: { rank: 1, populationAffected: "9007199254740993", rewriteMembersHash: "hh" } },
      { events: { findUnique, update } },
    );
    expect(ok.errors).toBeUndefined();
    expect(ok.data?.setEventAggregates).toEqual({ id: "e1", rewriteMembersHash: "hh" });
  });

  it("API-S-11 `event { rewriteMembersHash }` validates", async () => {
    const findUnique = vi.fn(async () => ({
      id: "e1", rewriteMembersHash: "abc", title: "t", rank: 1, severity: 1, createdAt: new Date(), updatedAt: new Date(),
    }));
    const r = await exec(
      `query { event(id: "e1") { id rewriteMembersHash } }`,
      undefined,
      { events: { findUnique } },
    );
    expect((r.errors ?? []).map((e) => e.extensions?.code)).not.toContain("GRAPHQL_VALIDATION_FAILED");
  });

  it("Signal exposes retracted: Boolean! and revision: Int!", async () => {
    const r = await exec(
      `{ __type(name: "Signal") { fields { name type { kind ofType { name } } } } }`, undefined,
    );
    const fields = (r.data as { __type: { fields: { name: string; type: { kind: string; ofType: { name: string } } }[] } }).__type.fields;
    for (const [name, t] of [["retracted", "Boolean"], ["revision", "Int"]]) {
      const f = fields.find((x) => x.name === name)!;
      expect(f.type.kind).toBe("NON_NULL");
      expect(f.type.ofType.name).toBe(t);
    }
    expect(fields.map((f) => f.name)).not.toContain("rawData");
  });
});
