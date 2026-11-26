/**
 * Decision records (ADR-0024, #585) against the real schema: each human
 * judgement writes one `decision_records` row in the same transaction as the
 * change, and a pipeline write over a decided field is refused without
 * failing.
 *
 * Self-seeding; runs against an empty scratch database:
 * `bun run test:db tests/resolvers/decisionRecords.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";
import { writeSignalLocation, writeSignalSeverity } from "../../src/services/signal-decided-fields.js";

const { updateSignalSeverity, updateSignalContent } = signalResolvers.Mutation;

const RUN = `dr-db-${Date.now()}`;
const ANALYST_ID = `${RUN}-analyst`;
const PIPELINE_ID = `${RUN}-pipeline-admin`;

const ctx = (id: string, role: string, extra: Partial<Context> = {}): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session", viaAgent: false, locale: "en", ...extra }) as unknown as Context;
/** A platform admin in the app. */
const analyst = ctx(ANALYST_ID, "admin");
/** The drain: an admin API key. */
const pipeline = ctx(PIPELINE_ID, "admin", { authMethod: "api-key" });

let sourceId: string | undefined;

async function newSignal(extra: Record<string, unknown> = {}) {
  return (
    await prisma.signals.create({
      data: { sourceId: sourceId!, rawData: {}, contentHash: `h-${Math.random()}`, publishedAt: new Date(), severity: 2, ...extra },
    })
  ).id;
}

const recordsFor = (subjectId: string) =>
  prisma.decisionRecords.findMany({ where: { subjectId }, orderBy: { sequence: "asc" } });

describeIfDb("Decision records against the real schema", () => {
  beforeAll(async () => {
    for (const id of [ANALYST_ID, PIPELINE_ID]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@example.test`, role: "admin" } });
    }
    sourceId = (await prisma.dataSources.create({ data: { name: `${RUN}-source`, type: "test" } })).id;
  });

  afterAll(async () => {
    if (sourceId) {
      const ids = (await prisma.signals.findMany({ where: { sourceId }, select: { id: true } })).map((s) => s.id);
      // Test cleanup only: no application path deletes a record.
      await prisma.decisionRecords.deleteMany({ where: { subjectId: { in: ids } } });
      await prisma.signals.deleteMany({ where: { sourceId } });
      await prisma.dataSources.deleteMany({ where: { id: sourceId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [ANALYST_ID, PIPELINE_ID] } } });
  });

  it("records a person's severity and keeps it against an API-key write", async () => {
    const signalId = await newSignal();

    const set = await updateSignalSeverity(null, { id: signalId, severity: 5 }, analyst);
    expect(set.severity).toBe(5);
    expect(set.severityCorrectedAt).toBeInstanceOf(Date);

    const records = await recordsFor(signalId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decisionType: "SIGNAL_SEVERITY_SET",
      subjectType: "signal",
      decidedById: ANALYST_ID,
      viaAgent: false,
      payload: { previousSeverity: 2, severity: 5 },
    });
    expect(records[0]!.decidedAt.getTime()).toBe(set.severityCorrectedAt!.getTime());

    const replay = await updateSignalSeverity(null, { id: signalId, severity: 1 }, pipeline);
    expect(replay.severity).toBe(5);
    expect(replay.severityCorrectedAt).not.toBeNull();
    expect(await recordsFor(signalId)).toHaveLength(1);
  });

  it("lets the pipeline set an undecided severity and writes no record", async () => {
    const signalId = await newSignal();
    const out = await updateSignalSeverity(null, { id: signalId, severity: 4 }, pipeline);
    expect(out).toMatchObject({ severity: 4, severityCorrectedAt: null });
    expect(await recordsFor(signalId)).toHaveLength(0);
  });

  it("leaves the Signal unchanged when the record cannot be written", async () => {
    const signalId = await newSignal();
    // A decider with no user row: the record's foreign key fails, and the
    // severity write in the same transaction rolls back.
    const ghost = ctx(`${RUN}-no-such-user`, "admin");
    await expect(updateSignalSeverity(null, { id: signalId, severity: 5 }, ghost)).rejects.toThrow();
    expect(await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).toMatchObject({
      severity: 2,
      severityCorrectedAt: null,
    });
    expect(await recordsFor(signalId)).toHaveLength(0);
  });

  it("keeps a decided severity through a source revision, and revises the rest", async () => {
    const signalId = await newSignal({ title: "Old title" });
    await updateSignalSeverity(null, { id: signalId, severity: 5 }, analyst);

    const revised = await updateSignalContent(
      null,
      { input: { id: signalId, contentHash: "revised", rawData: {}, title: "New title", severity: 1 } },
      pipeline,
    );
    expect(revised).toMatchObject({ title: "New title", severity: 5 });
    expect(revised!.severityCorrectedAt).not.toBeNull();
    expect(await recordsFor(signalId)).toHaveLength(1);
  });

  it("still lets a source revision set an undecided severity", async () => {
    const signalId = await newSignal();
    const revised = await updateSignalContent(
      null,
      { input: { id: signalId, contentHash: "revised", rawData: {}, severity: 4 } },
      pipeline,
    );
    expect(revised).toMatchObject({ severity: 4, severityCorrectedAt: null });
  });

  it("marks a decision the CLEAR Agent made for a user as the user's, through the Agent", async () => {
    const signalId = await newSignal();
    await updateSignalSeverity(null, { id: signalId, severity: 3 }, ctx(ANALYST_ID, "admin", { viaAgent: true }));
    const [record] = await recordsFor(signalId);
    expect(record).toMatchObject({ decidedById: ANALYST_ID, viaAgent: true });
  });

  it("keeps a deleted user's records and clears the decider", async () => {
    const goneId = `${RUN}-leaver`;
    await prisma.user.create({ data: { id: goneId, name: goneId, email: `${goneId}@example.test`, role: "admin" } });
    const signalId = await newSignal();
    await updateSignalSeverity(null, { id: signalId, severity: 4 }, ctx(goneId, "admin"));

    await prisma.user.delete({ where: { id: goneId } });

    const records = await recordsFor(signalId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decidedById: null, decisionType: "SIGNAL_SEVERITY_SET", payload: { severity: 4 } });
  });

  it("gives each record a larger sequence than the one before", async () => {
    const signalId = await newSignal();
    await updateSignalSeverity(null, { id: signalId, severity: 3 }, analyst);
    await updateSignalSeverity(null, { id: signalId, severity: 4 }, analyst);
    const [first, second] = await recordsFor(signalId);
    expect(second!.sequence > first!.sequence).toBe(true);
  });

  it("an offline override needs a named person and a rationale, and supersedes the earlier record", async () => {
    const signalId = await newSignal();
    await updateSignalSeverity(null, { id: signalId, severity: 5 }, analyst);
    const [earlier] = await recordsFor(signalId);

    await expect(
      prisma.$transaction((tx) =>
        writeSignalSeverity(tx, { signalId, severity: 1, caller: { kind: "override", decidedBy: ANALYST_ID, rationale: " " } }),
      ),
    ).rejects.toThrow(/rationale/);
    await expect(
      prisma.$transaction((tx) =>
        writeSignalSeverity(tx, { signalId, severity: 1, caller: { kind: "override", decidedBy: "", rationale: "Source retracted" } }),
      ),
    ).rejects.toThrow(/name the person/);
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).severity).toBe(5);

    await prisma.$transaction((tx) =>
      writeSignalSeverity(tx, {
        signalId,
        severity: 1,
        caller: { kind: "override", decidedBy: ANALYST_ID, rationale: "Source retracted the casualty count" },
      }),
    );
    expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).severity).toBe(1);
    const records = await recordsFor(signalId);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      decidedById: ANALYST_ID,
      rationale: "Source retracted the casualty count",
      supersedesId: earlier!.id,
      payload: { previousSeverity: 5, severity: 1 },
    });
  });

  it("the shared location write refuses the pipeline on a corrected Signal, and a named override writes and supersedes", async () => {
    const a = { id: `${RUN}-loc-a` };
    const b = { id: `${RUN}-loc-b` };
    for (const id of [a.id, b.id]) {
      await prisma.$executeRaw`INSERT INTO "locations" ("id", "name", "level", "ancestor_ids", "geometry")
        VALUES (${id}, ${id}, 4, ARRAY[]::text[], ST_GeomFromText('POINT(10 10)', 4326))`;
    }
    try {
      const signalId = await newSignal({ locationId: a.id, locationCorrectedAt: new Date() });

      const refused = await prisma.$transaction((tx) =>
        writeSignalLocation(tx, { signalId, locationId: b.id, caller: { kind: "pipeline" } }),
      );
      expect(refused).toEqual({ refused: true, kept: a.id });
      expect((await prisma.signals.findUniqueOrThrow({ where: { id: signalId } })).locationId).toBe(a.id);

      await prisma.$transaction((tx) =>
        writeSignalLocation(tx, {
          signalId,
          locationId: b.id,
          caller: { kind: "override", decidedBy: ANALYST_ID, rationale: "Legacy point removed" },
        }),
      );
      const after = await prisma.signals.findUniqueOrThrow({ where: { id: signalId } });
      expect(after.locationId).toBe(b.id);
      expect(after.locationCorrectedAt).not.toBeNull();
      const records = await recordsFor(signalId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        decisionType: "SIGNAL_LOCATION_DECIDED",
        decidedById: ANALYST_ID,
        rationale: "Legacy point removed",
        supersedesId: null,
        payload: { decision: "OVERRIDE", previousLocationId: a.id, appliedLocationId: b.id },
      });
    } finally {
      await prisma.signals.updateMany({ where: { sourceId: sourceId! }, data: { locationId: null } });
      await prisma.locations.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    }
  });
});
