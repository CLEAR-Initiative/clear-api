/**
 * Decision records V2 (ADR-0024, #1289) against the real schema: every
 * remaining human judgement on an Alert, Event, Signal or hotline thread writes
 * one `decision_records` row in its transaction. Crisis changes record nothing
 * until the ontology owner settles how a Crisis is created.
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

const { createCrisisFromEvents, addEventToCrisis, removeEventFromCrisis } = crisisResolvers.Mutation;
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

  it("records one escalation when two overlap on an existing Alert", async () => {
    const e = await newEvent();
    await prisma.alerts.create({ data: { eventId: e, status: "published" } });
    await Promise.all([
      escalateEvent(null, { eventId: e, userId: ADMIN_ID }, admin),
      escalateEvent(null, { eventId: e, userId: ADMIN_ID }, admin),
    ]);
    const records = await recordsFor("event", e);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decisionType: "EVENT_ESCALATED", payload: { raisedAlert: false } });
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
    expect(updated.payload).toMatchObject({ changes: { severity: 4 }, previous: { severity: 3, title: "Floods" } });

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

  it("an Event edit whose record fails leaves no new Signal link", async () => {
    const e = await newEvent();
    const source = await prisma.dataSources.findFirstOrThrow({ where: { name: "field_officer" } });
    const signal = await prisma.signals.create({ data: { sourceId: source.id, rawData: {}, publishedAt: new Date() } });
    signalIds.push(signal.id);
    const ghost = ctx(`${RUN}-no-such-user`, "admin");
    await expect(updateEvent(null, { id: e, input: { signalIds: [signal.id], severity: 5 } }, ghost)).rejects.toThrow();
    expect(await prisma.signalEvents.count({ where: { eventId: e } })).toBe(0);

    await updateEvent(null, { id: e, input: { signalIds: [signal.id] } }, admin);
    expect(await prisma.signalEvents.count({ where: { eventId: e } })).toBe(1);
    expect((await recordsFor("event", e)).at(-1)!.payload).toMatchObject({ linkedSignalIds: [signal.id] });
    await prisma.signalEvents.deleteMany({ where: { eventId: e } });
  });

  it("creates a Crisis with no rationale and records no decision (Crisis rules wait for the ontology)", async () => {
    const e = await newEvent();
    const crisis = await createCrisisFromEvents(null, { input: { severity: 3, needs: {}, eventIds: [e] } }, admin);
    crisisIds.push(crisis.id);
    expect(await recordsFor("crisis", crisis.id)).toHaveLength(0);
  });

  it("two Events added to a Crisis at once both count in its population", async () => {
    const now = new Date();
    const withPop = async (n: bigint) => {
      const row = await prisma.events.create({
        data: { types: [], validTo: now, firstSignalCreatedAt: now, lastSignalCreatedAt: now, rank: 0, populationAffected: n },
      });
      eventIds.push(row.id);
      return row.id;
    };
    const [a, b, c] = [await withPop(100n), await withPop(20n), await withPop(3n)];
    const crisis = await createCrisisFromEvents(null, { input: { severity: 3, needs: {}, eventIds: [a] } }, admin);
    crisisIds.push(crisis.id);
    await Promise.all([
      addEventToCrisis(null, { crisisId: crisis.id, eventId: b }, admin),
      addEventToCrisis(null, { crisisId: crisis.id, eventId: c }, admin),
    ]);
    expect((await prisma.crises.findUniqueOrThrow({ where: { id: crisis.id } })).populationAffected).toBe(123n);
  });

  it("two overlapping removals of the same Event remove it once and keep the Crisis", async () => {
    const [a, b] = [await newEvent(), await newEvent()];
    const crisis = await createCrisisFromEvents(null, { input: { severity: 3, needs: {}, eventIds: [a, b] } }, admin);
    crisisIds.push(crisis.id);
    const results = await Promise.allSettled([
      removeEventFromCrisis(null, { crisisId: crisis.id, eventId: a }, admin),
      removeEventFromCrisis(null, { crisisId: crisis.id, eventId: a }, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { extensions: { code: "NOT_FOUND" } } });
    expect(await prisma.crises.findUnique({ where: { id: crisis.id } })).not.toBeNull();
    expect(await prisma.eventCrises.findMany({ where: { crisisId: crisis.id }, select: { eventId: true } })).toEqual([{ eventId: b }]);
  });
});
