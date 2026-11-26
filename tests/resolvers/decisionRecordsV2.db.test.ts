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
import { alertResolvers } from "../../src/resolvers/alert.resolver.js";
import { eventResolvers } from "../../src/resolvers/event.resolver.js";
import { signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const {
  createCrisisFromEvents, addEventToCrisis, removeEventFromCrisis, updateCrisisTitle, updateCrisisDescription,
  addCrisisAttachments, removeCrisisAttachment, deleteCrisis,
} = crisisResolvers.Mutation;
const { createAlert, updateAlert, deleteAlert } = alertResolvers.Mutation;
const { escalateEvent, createEvent, updateEvent, deleteEvent } = eventResolvers.Mutation;
const { createManualSignal, deleteSignal } = signalResolvers.Mutation;

const RUN = `dr2-db-${Date.now()}`;
const ADMIN_ID = `${RUN}-admin`;

const ctx = (id: string, role: string, extra: Partial<Context> = {}): Context =>
  ({ prisma, user: { id, role }, session: null, authMethod: "session", viaAgent: false, locale: "en", ...extra }) as unknown as Context;
const admin = ctx(ADMIN_ID, "admin");
/** The drain: an admin API key. */
const pipeline = ctx(ADMIN_ID, "admin", { authMethod: "api-key" });

const eventIds: string[] = [];
const signalIds: string[] = [];
const crisisIds: string[] = [];

/** An Event with no classified types: the NRC-relevance gate on Alerts does
 *  not apply, so the empty scratch database needs no disaster types. */
async function newEvent() {
  const now = new Date();
  const row = await prisma.events.create({
    data: { types: [], validTo: now, firstSignalCreatedAt: now, lastSignalCreatedAt: now, rank: 0 },
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
    await prisma.eventEscaladedByUsers.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.alerts.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.signals.deleteMany({ where: { id: { in: signalIds } } });
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

  it("adds an Event to a Crisis only with a rationale, and records it once", async () => {
    const [a, b] = [await newEvent(), await newEvent()];
    const crisis = await createCrisisFromEvents(null, crisisInput([a], { rationale: "Floods" }), admin);
    crisisIds.push(crisis.id);

    await expect(addEventToCrisis(null, { crisisId: crisis.id, eventId: b }, admin)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", field: "rationale" },
    });
    expect(await prisma.eventCrises.count({ where: { crisisId: crisis.id, eventId: b } })).toBe(0);

    await addEventToCrisis(null, { crisisId: crisis.id, eventId: b, rationale: "Same river basin" }, admin);
    // A repeat call on the existing link changes nothing and records nothing.
    await addEventToCrisis(null, { crisisId: crisis.id, eventId: b, rationale: "Again" }, admin);

    const added = (await recordsFor("crisis", crisis.id)).filter((r) => r.decisionType === "CRISIS_EVENT_ADDED");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ decidedById: ADMIN_ID, rationale: "Same river basin", payload: { eventId: b } });
  });

  it("adds no Event when the record cannot be written", async () => {
    const [a, b] = [await newEvent(), await newEvent()];
    const crisis = await createCrisisFromEvents(null, crisisInput([a], { rationale: "Floods" }), admin);
    crisisIds.push(crisis.id);
    const ghost = ctx(`${RUN}-no-such-user`, "admin");
    await expect(addEventToCrisis(null, { crisisId: crisis.id, eventId: b, rationale: "Why" }, ghost)).rejects.toThrow();
    expect(await prisma.eventCrises.count({ where: { crisisId: crisis.id, eventId: b } })).toBe(0);
  });

  it("records a person raising, changing and deleting an Alert; the pipeline's Alert has no record", async () => {
    const e = await newEvent();
    const raised = await createAlert(null, { input: { eventId: e, status: "draft" } }, admin);
    // An idempotent repeat with the same status changes nothing.
    await createAlert(null, { input: { eventId: e, status: "draft" } }, admin);
    await createAlert(null, { input: { eventId: e, status: "archived" } }, admin);
    await updateAlert(null, { id: raised!.id, input: { status: "draft" } }, admin);
    await deleteAlert(null, { id: raised!.id }, admin);

    const records = await recordsFor("alert", raised!.id);
    expect(records.map((r) => [r.decisionType, (r.payload as { status: string }).status])).toEqual([
      ["ALERT_RAISED", "draft"],
      ["ALERT_UPDATED", "archived"],
      ["ALERT_UPDATED", "draft"],
      ["ALERT_DELETED", "draft"],
    ]);
    expect(records.every((r) => r.decidedById === ADMIN_ID)).toBe(true);

    const machine = await newEvent();
    const byPipeline = await createAlert(null, { input: { eventId: machine, status: "draft" } }, pipeline);
    expect(await recordsFor("alert", byPipeline!.id)).toHaveLength(0);
  });

  it("records an escalation once: with the Alert it raises, or with a new escalation of an existing one", async () => {
    const e = await newEvent();
    // The decider is the session's user, whatever userId the client sends.
    await escalateEvent(null, { eventId: e, userId: ADMIN_ID }, admin);
    await escalateEvent(null, { eventId: e, userId: ADMIN_ID }, admin);
    const records = await recordsFor("event", e);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decisionType: "EVENT_ESCALATED", decidedById: ADMIN_ID, payload: { raisedAlert: true } });
  });

  it("records a person filing a manual Signal, in the creating transaction", async () => {
    const source = await prisma.dataSources.findFirstOrThrow({ where: { name: "field_officer" } });
    const signal = await createManualSignal(
      null,
      { input: { sourceId: source.id, title: "Clashes near the market", severity: 4 } },
      admin,
    );
    signalIds.push(signal.id);
    const records = await recordsFor("signal", signal.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decisionType: "SIGNAL_CREATED",
      decidedById: ADMIN_ID,
      payload: { sourceId: source.id, severity: 4 },
    });
  });

  it("records a person creating, editing and deleting an Event; the pipeline's Event has no record", async () => {
    const now = new Date().toISOString();
    const base = { signalIds: [], validFrom: now, firstSignalCreatedAt: now, lastSignalCreatedAt: now, types: [], rank: 0 };
    const mine = await createEvent(null, { input: { ...base, title: "Floods", severity: 3 } }, admin);
    eventIds.push(mine.id);
    await updateEvent(null, { id: mine.id, input: { severity: 4 } }, admin);
    await deleteEvent(null, { id: mine.id }, admin);
    expect((await recordsFor("event", mine.id)).map((r) => r.decisionType)).toEqual([
      "EVENT_CREATED",
      "EVENT_UPDATED",
      "EVENT_DELETED",
    ]);
    const updated = (await recordsFor("event", mine.id))[1]!;
    expect(updated.payload).toMatchObject({ fields: ["severity"], previous: { severity: 3 } });

    const machine = await createEvent(null, { input: { ...base, title: "Pipeline" } }, pipeline);
    eventIds.push(machine.id);
    await updateEvent(null, { id: machine.id, input: { severity: 2 } }, pipeline);
    expect(await recordsFor("event", machine.id)).toHaveLength(0);
  });

  it("records a person deleting a Signal; the record outlives it", async () => {
    const source = await prisma.dataSources.findFirstOrThrow({ where: { name: "field_officer" } });
    const signal = await prisma.signals.create({ data: { sourceId: source.id, rawData: {}, publishedAt: new Date(), title: "Gone" } });
    await deleteSignal(null, { id: signal.id }, admin);
    const records = await recordsFor("signal", signal.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decisionType: "SIGNAL_DELETED", decidedById: ADMIN_ID, payload: { title: "Gone" } });
  });

  it("records each edit of a Crisis, the removal of its Events and its deletion", async () => {
    const [a, b] = [await newEvent(), await newEvent()];
    const crisis = await createCrisisFromEvents(null, crisisInput([a, b], { rationale: "Floods" }), admin);
    crisisIds.push(crisis.id);

    await updateCrisisTitle(null, { id: crisis.id, title: "Nile floods" }, admin);
    await updateCrisisDescription(null, { id: crisis.id, description: "Rising water" }, admin);
    await addCrisisAttachments(null, { id: crisis.id, keys: ["k1", "k2"] }, admin);
    await addCrisisAttachments(null, { id: crisis.id, keys: ["k1"] }, admin); // nothing new: no record
    await removeCrisisAttachment(null, { id: crisis.id, key: "k2" }, admin);
    await removeCrisisAttachment(null, { id: crisis.id, key: "absent" }, admin); // nothing removed: no record
    await removeEventFromCrisis(null, { crisisId: crisis.id, eventId: b }, admin);

    const records = await recordsFor("crisis", crisis.id);
    expect(records.map((r) => [r.decisionType, (r.payload as { field?: string }).field ?? null])).toEqual([
      ["CRISIS_CREATED", null],
      ["CRISIS_EDITED", "title"],
      ["CRISIS_EDITED", "description"],
      ["CRISIS_EDITED", "attachments"],
      ["CRISIS_EDITED", "attachments"],
      ["CRISIS_EVENT_REMOVED", null],
    ]);
    expect(records.at(-1)!.payload).toMatchObject({ eventId: b, crisisDeleted: false });

    await deleteCrisis(null, { id: crisis.id }, admin);
    expect((await recordsFor("crisis", crisis.id)).at(-1)).toMatchObject({ decisionType: "CRISIS_DELETED", decidedById: ADMIN_ID });
  });

  it("removing a Crisis's last Event deletes it and records that", async () => {
    const a = await newEvent();
    const crisis = await createCrisisFromEvents(null, crisisInput([a], { rationale: "Floods" }), admin);
    expect(await removeEventFromCrisis(null, { crisisId: crisis.id, eventId: a }, admin)).toBeNull();
    expect((await recordsFor("crisis", crisis.id)).at(-1)).toMatchObject({
      decisionType: "CRISIS_EVENT_REMOVED",
      payload: { eventId: a, crisisDeleted: true },
    });
  });
});
