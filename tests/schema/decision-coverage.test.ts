/**
 * Every human judgement on an Event, Alert, Crisis, Signal, case or hotline
 * thread writes a DecisionRecord (ADR-0024, #1289).
 *
 * Each mutation whose name touches one of those is classified here: either it
 * records a decision, or it is not a decision and says why. A new mutation on
 * those entities fails this test until someone classifies it. A mutation listed
 * as a decision fails when its resolver calls no recorder.
 *
 * The db tests (`tests/resolvers/decisionRecords*.db.test.ts`) prove the
 * records are written and roll back with the change; this file proves none is
 * forgotten.
 */
import { describe, it, expect } from "vitest";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";

/** Mutations that record a person's decision, with the type they record. */
const DECISIONS: Record<string, string> = {
  addCrisisAttachments: "CRISIS_EDITED",
  addEventToCrisis: "CRISIS_EVENT_ADDED",
  createAlert: "ALERT_RAISED / ALERT_UPDATED",
  createCrisisFromEvents: "CRISIS_CREATED",
  createEvent: "EVENT_CREATED",
  createManualSignal: "SIGNAL_CREATED",
  decideCaseProposal: "CASE_PROPOSAL_DECIDED",
  decideSignalLocationChallenge: "SIGNAL_LOCATION_DECIDED",
  deleteAlert: "ALERT_DELETED",
  deleteCrisis: "CRISIS_DELETED",
  deleteEvent: "EVENT_DELETED",
  deleteSignal: "SIGNAL_DELETED",
  escalateEvent: "EVENT_ESCALATED",
  removeCrisisAttachment: "CRISIS_EDITED",
  removeEventFromCrisis: "CRISIS_EVENT_REMOVED",
  reviewGroundThread: "GROUND_THREAD_REVIEWED",
  updateAlert: "ALERT_UPDATED",
  updateCrisisDescription: "CRISIS_EDITED",
  updateCrisisTitle: "CRISIS_EDITED",
  updateEvent: "EVENT_UPDATED",
  updateSignalSeverity: "SIGNAL_SEVERITY_SET",
};

const PIPELINE = "a pipeline write: reproducible from bronze plus versions";
const DELIVERY = "notification or delivery configuration, not a judgement on content";
const SOURCE_CONFIG = "source registry configuration, not a judgement on content";

/** Mutations on those entities that are not a decision, and why. */
const NOT_DECISIONS: Record<string, string> = {
  archiveStaleAlerts: "a fixed age rule; recomputable",
  createAlertWebhook: DELIVERY,
  createGroundSource: SOURCE_CONFIG,
  createPublicEventLink: "sharing an Event; changes no content",
  createSignal: "ingest; a person's promotion is recorded by reviewGroundThread or decideCaseProposal",
  deleteAlertWebhook: DELIVERY,
  fileSignalLocationChallengeFromPipeline: "a proposal; decideSignalLocationChallenge records the decision",
  grantApiSignalSource: "access control, not a judgement on content",
  markCrisisEnriched: PIPELINE,
  markGroundMessagesFailed: PIPELINE,
  markSignalsProcessed: PIPELINE,
  notifyAlertDigest: DELIVERY,
  notifyAlertSubscribers: DELIVERY,
  requestEventEnrichment: "asks a Worker for proposals; decideCaseProposal records the decision",
  requestGroundMessageTranslation: "re-queues processing; changes no content",
  requeueSignals: "re-queues Signals for the drain; recomputable",
  retryGroundMessage: "re-queues processing; changes no content",
  revokeApiSignalSource: "access control, not a judgement on content",
  revokePublicEventLink: "sharing an Event; changes no content",
  rotateAlertWebhookSecret: DELIVERY,
  sendTestWebhookEvent: DELIVERY,
  setCrisisNeedsAnalysis: PIPELINE,
  setEventAggregates: PIPELINE,
  setGroundSourceActive: SOURCE_CONFIG,
  setSignalGlideCode: PIPELINE,
  submitSignalLocationChallenge: "a proposal that never changes the Signal; the decision records",
  subscribeToAlerts: DELIVERY,
  subscribeToAlertsBatch: DELIVERY,
  syncEventCards: PIPELINE,
  unsubscribeFromAlerts: DELIVERY,
  updateAlertSubscription: DELIVERY,
  updateAlertWebhook: DELIVERY,
  updateCrisisPopulation: PIPELINE,
  updateGroundSource: SOURCE_CONFIG,
  updateSignalContent: `${PIPELINE}; a decided severity or location is kept`,
  updateSignalGeoparsedData: PIPELINE,
  updateSignalLocation: `${PIPELINE}; a decided location is kept`,
  upsertGroundMessageClassifications: PIPELINE,
  upsertGroundMessageTranscripts: PIPELINE,
  upsertGroundThreadDrafts: PIPELINE,
  upsertGroundThreads: PIPELINE,
};

/** Names a resolver uses to record a decision. */
const RECORDERS = ["recordDecision", "recordDecisionIfPerson", "recordCrisisEdit", "writeSignalSeverity"];

const DOMAIN = /crisis|crises|alert|event|signal|case|ground/i;

const schema = makeExecutableSchema({ typeDefs, resolvers });
const mutationNames = Object.keys(schema.getMutationType()!.getFields());
const domainMutations = mutationNames.filter((n) => DOMAIN.test(n));

const resolverFor = (name: string): unknown => {
  for (const r of resolvers) {
    const fn = (r as { Mutation?: Record<string, unknown> }).Mutation?.[name];
    if (fn) return fn;
  }
  return undefined;
};

describe("decision coverage", () => {
  it("classifies every mutation on an Event, Alert, Crisis, Signal, case or hotline thread", () => {
    const unclassified = domainMutations.filter((n) => !(n in DECISIONS) && !(n in NOT_DECISIONS));
    expect(unclassified, "classify each new mutation in DECISIONS or NOT_DECISIONS").toEqual([]);
  });

  it("lists no mutation twice and none that does not exist", () => {
    const both = Object.keys(DECISIONS).filter((n) => n in NOT_DECISIONS);
    expect(both).toEqual([]);
    const gone = [...Object.keys(DECISIONS), ...Object.keys(NOT_DECISIONS)].filter((n) => !mutationNames.includes(n));
    expect(gone).toEqual([]);
  });

  it.each(Object.keys(DECISIONS))("%s records a decision", (name) => {
    const source = String(resolverFor(name));
    expect(RECORDERS.some((r) => source.includes(r)), `${name} calls none of ${RECORDERS.join(", ")}`).toBe(true);
  });
});
