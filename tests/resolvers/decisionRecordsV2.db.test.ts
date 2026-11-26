/**
 * Decision records V2 (ADR-0024, #1289) against the real schema: every
 * remaining human judgement on a Crisis, Alert, Event, Signal or hotline thread
 * writes one `decision_records` row in its transaction, and a Crisis cannot be
 * created, or gain an Event, without a rationale.
 *
 * Self-seeding; runs against an empty scratch database:
 * `bun run test:db tests/resolvers/decisionRecordsV2.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { crisisResolvers } from "../../src/resolvers/crisis.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { createCrisisFromEvents } = crisisResolvers.Mutation;

const RUN = `dr2-db-${Date.now()}`;
const ADMIN_ID = `${RUN}-admin`;

const ctx = (id: string, role: string, extra: Partial<Context> = {}): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session", viaAgent: false, locale: "en", ...extra }) as unknown as Context;
const admin = ctx(ADMIN_ID, "admin");
/** The drain: an admin API key. */
const pipeline = ctx(ADMIN_ID, "admin", { authMethod: "api-key" });

const eventIds: string[] = [];
const crisisIds: string[] = [];

async function newEvent() {
  const now = new Date();
  const row = await prisma.events.create({
    data: { types: ["FL"], validTo: now, firstSignalCreatedAt: now, lastSignalCreatedAt: now, rank: 0 },
  });
  eventIds.push(row.id);
  return row.id;
}

const recordsFor = (subjectType: string, subjectId: string) =>
  prisma.decisionRecords.findMany({ where: { subjectType, subjectId }, orderBy: { sequence: "asc" } });

const crisisInput = (ids: string[], extra: Record<string, unknown> = {}) => ({
  input: { severity: 3, needs: {}, eventIds: ids, ...extra },
});

describeIfDb("Decision records V2 against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: ADMIN_ID, name: ADMIN_ID, email: `${ADMIN_ID}@example.test`, role: "admin" } });
  });

  afterAll(async () => {
    // Test cleanup only: no application path deletes a record.
    await prisma.decisionRecords.deleteMany({ where: { decidedById: ADMIN_ID } });
    await prisma.activityLogs.deleteMany({ where: { userId: ADMIN_ID } });
    await prisma.userFeedbacks.deleteMany({ where: { userId: ADMIN_ID } });
    await prisma.crises.deleteMany({ where: { id: { in: crisisIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.user.deleteMany({ where: { id: ADMIN_ID } });
  });

  it("refuses to create a Crisis without a rationale, and creates nothing", async () => {
    const e = await newEvent();
    for (const rationale of [undefined, null, "", "   "]) {
      await expect(createCrisisFromEvents(null, crisisInput([e], { rationale }), admin)).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT", field: "rationale" },
      });
    }
    expect(await prisma.eventCrises.count({ where: { eventId: e } })).toBe(0);
  });

  it("creates a Crisis with one record holding the person and the reason", async () => {
    const e = await newEvent();
    const crisis = await createCrisisFromEvents(
      null,
      crisisInput([e], { rationale: "  Displacement across two districts.  ", title: "Floods" }),
      admin,
    );
    crisisIds.push(crisis.id);
    const records = await recordsFor("crisis", crisis.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decisionType: "CRISIS_CREATED",
      decidedById: ADMIN_ID,
      rationale: "Displacement across two districts.",
      payload: { eventIds: [e], title: "Floods", severity: 3 },
    });
  });

  it("refuses a pipeline caller: a Crisis is a person's decision", async () => {
    const e = await newEvent();
    await expect(
      createCrisisFromEvents(null, crisisInput([e], { rationale: "Because" }), pipeline),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(await prisma.eventCrises.count({ where: { eventId: e } })).toBe(0);
  });

  it("creates no Crisis when the record cannot be written", async () => {
    const e = await newEvent();
    const ghost = ctx(`${RUN}-no-such-user`, "admin");
    await expect(createCrisisFromEvents(null, crisisInput([e], { rationale: "Because" }), ghost)).rejects.toThrow();
    expect(await prisma.eventCrises.count({ where: { eventId: e } })).toBe(0);
  });
});
