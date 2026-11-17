/**
 * Pipeline-owned Signal ids against the real schema: createSignal stores a
 * supplied lowercase UUIDv5, refuses any other supplied id, and dedupes on
 * (sourceId, externalId) and on the primary key. Self-seeding; run with
 * `bun run test:db`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../../src/context.js";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `sid-db-${Date.now()}`;
let sourceId = "";
let otherSourceId = "";
let manualSourceId = "";
let n = 0;

// The gx pipeline authenticates as a system admin through an API key.
const ctx = { prisma, user: { id: "pipeline", role: "admin" }, session: null, authMethod: "apiKey", locale: "en" } as unknown as Context;
const { createSignal, createManualSignal } = signalResolvers.Mutation;

/** A fresh id shaped like a lowercase UUIDv5 (version nibble 5, RFC variant). */
const newV5Id = () => randomUUID().replace(/^(.{14})./, "$15");

const create = (input: Record<string, unknown>, context: Context = ctx) =>
  createSignal({}, { input: { sourceId, rawData: {}, publishedAt: "2026-11-16T09:00:00Z", ...input } as never }, context);

const bound = <T extends object>(target: T, key: string | symbol) => {
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
};

/** A context whose (sourceId, externalId) pre-check misses once, as when a
 *  concurrent create commits between that check and the insert. */
function losingRaceCtx(): Context {
  let missed = false;
  const signals = new Proxy(prisma.signals, {
    get: (target, key) =>
      key !== "findUnique"
        ? bound(target, key)
        : (args: { where: { sourceId_externalId?: unknown } }) => {
            if (missed || !args.where.sourceId_externalId) return target.findUnique(args as never);
            missed = true;
            return Promise.resolve(null);
          },
  });
  const client = new Proxy(prisma, { get: (target, key) => (key === "signals" ? signals : bound(target, key)) });
  return { ...ctx, prisma: client } as Context;
}

/** A context whose unique-clash errors carry no metadata, as a Prisma upgrade
 *  or another driver adapter might report them: only `code` survives. */
function bareP2002Ctx(base: Context): Context {
  const signals = new Proxy(base.prisma.signals, {
    get: (target, key) =>
      key !== "create"
        ? bound(target, key)
        : async (args: unknown) => {
            try {
              return await target.create(args as never);
            } catch (err) {
              if ((err as { code?: unknown }).code === "P2002") throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
              throw err;
            }
          },
  });
  const client = new Proxy(base.prisma, { get: (target, key) => (key === "signals" ? signals : bound(target, key)) });
  return { ...base, prisma: client } as Context;
}

describeIfDb("pipeline-owned Signal ids", () => {
  beforeAll(async () => {
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-gx`, type: "test" } })).id;
    otherSourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-other`, type: "test" } })).id;
    // createManualSignal only files under a trusted source name.
    manualSourceId = (await prisma.dataSources.create({ data: { name: "field_officer", type: "test" } })).id;
  });

  afterAll(async () => {
    await prisma.signals.deleteMany({ where: { sourceId: { in: [sourceId, otherSourceId, manualSourceId] } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: [sourceId, otherSourceId, manualSourceId] } } });
  });

  it("stores a supplied lowercase UUIDv5 as the Signal id", async () => {
    const id = newV5Id();
    const signal = await create({ id, externalId: `idmc:${RUN}-${n++}` });
    expect(signal.id).toBe(id);
    expect((await prisma.signals.findUniqueOrThrow({ where: { id } })).id).toBe(id);
  });

  it("mints a cuid when no id is supplied", async () => {
    const signal = await create({ externalId: `idmc:${RUN}-${n++}` });
    expect(signal.id).toMatch(/^c[a-z0-9]{24}$/);
  });

  it.each([
    ["a UUIDv4", { id: "0b6f1c2e-8d4a-4f3b-9a1c-2e3d4f5a6b7c", externalId: "idmc:v4" }],
    ["an uppercase UUIDv5", { id: "0B6F1C2E-8D4A-5F3B-9A1C-2E3D4F5A6B7C", externalId: "idmc:upper" }],
    ["a cuid", { id: "cmwj6mtsu0001nsyrrkaf1tzc", externalId: "idmc:cuid" }],
    ["an arbitrary string", { id: "my-signal", externalId: "idmc:arbitrary" }],
    ["a UUIDv5 without externalId", { id: "0b6f1c2e-8d4a-5f3b-9a1c-2e3d4f5a6b7c" }],
    ["a UUIDv5 on a manual payload", { id: "0b6f1c2e-8d4a-5f3b-9a1c-2e3d4f5a6b7c", externalId: "idmc:manual", rawData: { manual: true } }],
  ])("refuses %s with BAD_USER_INPUT and writes nothing", async (_label, input) => {
    await expect(create(input)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(await prisma.signals.count({ where: { sourceId, id: input.id } })).toBe(0);
  });

  it("returns an existing (sourceId, externalId) row unchanged, even with a different id", async () => {
    const externalId = `idmc:${RUN}-${n++}`;
    const legacy = await create({ externalId, title: "first" });
    const again = await create({ id: newV5Id(), externalId, title: "second" });
    expect(again).toEqual(legacy);
    expect(await prisma.signals.count({ where: { sourceId, externalId } })).toBe(1);
  });

  it("gives one row and no error for concurrent creates of the same UUIDv5", async () => {
    const id = newV5Id();
    const externalId = `idmc:${RUN}-${n++}`;
    const results = await Promise.all([1, 2, 3].map(() => create({ id, externalId })));
    expect(results.map((r) => r.id)).toEqual([id, id, id]);
    expect(await prisma.signals.count({ where: { sourceId, externalId } })).toBe(1);
  });

  it("raises CONFLICT when the UUIDv5 already belongs to another externalId", async () => {
    const id = newV5Id();
    await create({ id, externalId: `idmc:${RUN}-${n++}` });
    await expect(create({ id, externalId: `idmc:${RUN}-${n++}` })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });

  it("raises CONFLICT when the UUIDv5 already belongs to the same externalId under another source", async () => {
    const id = newV5Id();
    const externalId = `idmc:${RUN}-${n++}`;
    await create({ id, externalId });
    await expect(create({ id, externalId, sourceId: otherSourceId })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });

  it("returns the winner's row when a create loses the race to the same UUIDv5", async () => {
    const id = newV5Id();
    const externalId = `idmc:${RUN}-${n++}`;
    const winner = await create({ id, externalId });
    expect(await create({ id, externalId }, losingRaceCtx())).toEqual(winner);
  });

  it("returns the winner's row when a create with another id loses the race to the same externalId", async () => {
    const externalId = `idmc:${RUN}-${n++}`;
    const winner = await create({ externalId });
    expect(await create({ id: newV5Id(), externalId }, losingRaceCtx())).toEqual(winner);
    expect(await prisma.signals.count({ where: { sourceId, externalId } })).toBe(1);
  });

  describe("when the unique-clash error carries no constraint metadata", () => {
    it("still raises CONFLICT for an id held by another externalId", async () => {
      const id = newV5Id();
      await create({ id, externalId: `idmc:${RUN}-${n++}` });
      await expect(create({ id, externalId: `idmc:${RUN}-${n++}` }, bareP2002Ctx(ctx))).rejects.toMatchObject({
        extensions: { code: "CONFLICT" },
      });
    });

    it("still returns the winner's row when a create loses the race to the same UUIDv5", async () => {
      const id = newV5Id();
      const externalId = `idmc:${RUN}-${n++}`;
      const winner = await create({ id, externalId });
      expect(await create({ id, externalId }, bareP2002Ctx(losingRaceCtx()))).toEqual(winner);
    });

    it("still returns the winner's row when a create with another id loses the race to the same externalId", async () => {
      const externalId = `idmc:${RUN}-${n++}`;
      const winner = await create({ externalId });
      expect(await create({ id: newV5Id(), externalId }, bareP2002Ctx(losingRaceCtx()))).toEqual(winner);
    });
  });

  it("gives a manual Signal a cuid, distinct from a pipeline id for the same content", async () => {
    const pipelineId = newV5Id();
    await create({ id: pipelineId, externalId: `idmc:${RUN}-${n++}`, title: "Flooding in Kassala" });
    const manual = await createManualSignal(
      {},
      { input: { sourceId: manualSourceId, title: "Flooding in Kassala", description: "Reported by a field officer" } },
      ctx,
    );
    expect(manual.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(manual.id).not.toBe(pipelineId);
  });

  const rawInsert = (id: string) => prisma.$executeRaw`
    INSERT INTO signals (id, source_id, external_id, raw_data, published_at, collected_at)
    VALUES (${id}, ${sourceId}, ${`raw:${RUN}-${n++}`}, '{}'::jsonb, now(), now())`;

  it.each([
    ["a cuid", "cmwj6mtsu0001nsyrrkaf1tzc"],
    ["a case id", "case0b6f1c2e8d4a4f3b9a1c2e3d4f5a6b7c"],
    ["a lowercase UUIDv5", "1b6f1c2e-8d4a-5f3b-9a1c-2e3d4f5a6b7c"],
  ])("the id CHECK accepts %s", async (_label, id) => {
    expect(await rawInsert(id)).toBe(1);
  });

  it.each([
    ["a UUIDv4", "0b6f1c2e-8d4a-4f3b-9a1c-2e3d4f5a6b7c"],
    ["an uppercase UUIDv5", "0B6F1C2E-8D4A-5F3B-9A1C-2E3D4F5A6B7C"],
    ["an arbitrary id", `${RUN}-legacy`],
  ])("the id CHECK rejects %s", async (_label, id) => {
    await expect(rawInsert(id)).rejects.toThrow(/signals_id_format/);
  });
});
