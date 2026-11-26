/**
 * The one write path for a Signal's decided fields: severity and location
 * (ADR-0024). Mutations and offline scripts both write through here, so the
 * guard is in one place.
 *
 * - A person writes the value, stamps `*_corrected_at`, and records a
 *   DecisionRecord holding the old and new value.
 * - The pipeline writes the value unless a person decided it. Then it writes
 *   nothing and gets `{ refused: true }` with the kept value; the call does
 *   not fail, because the drain retries a failed mutation and would loop.
 *
 * - An offline script that must override a decided field names a person and a
 *   reason (`override`). The value is written, the stamp kept, and a record
 *   superseding the latest one for that Signal and type is written.
 *
 * Each function locks the Signal row first, as the Location challenge
 * decision does, so a person's write and a pipeline write cannot interleave.
 */
import type { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import { latestDecision, recordDecision } from "./decision-records.js";
import { createLogger } from "../utils/logger.js";

type Tx = Prisma.TransactionClient;

const log = createLogger("signal-decided-fields");

/** An offline script's override: a named person and why. */
export type OverrideCaller = { kind: "override"; decidedBy: string; rationale: string };

export type SignalFieldCaller =
  | { kind: "person"; context: Pick<Context, "user" | "authMethod" | "viaAgent"> }
  | { kind: "pipeline" }
  | OverrideCaller;

export class OverrideError extends Error {}

function assertOverride(caller: OverrideCaller) {
  if (!caller.decidedBy?.trim()) throw new OverrideError("An override must name the person who decided");
  if (!caller.rationale?.trim()) throw new OverrideError("An override must give a rationale");
}

export type DecidedFieldResult<T> =
  | { refused: false; value: T }
  | { refused: true; kept: T };

export class SignalNotFoundError extends Error {
  constructor(readonly signalId: string) {
    super(`Signal ${signalId} not found`);
  }
}

async function lockSignal(tx: Tx, signalId: string) {
  await tx.$queryRaw`SELECT id FROM "signals" WHERE id = ${signalId} FOR UPDATE`;
}

/** One structured line per refused pipeline write: the refusal metric. */
export function logRefusedWrite(field: "severity" | "location", signalId: string, via: string) {
  log.info({ event: "decided_field_write_refused", field, signalId, via }, "pipeline write over a decided field refused");
}

export async function writeSignalSeverity(
  tx: Tx,
  input: { signalId: string; severity: number; caller: SignalFieldCaller; via?: string },
): Promise<DecidedFieldResult<number | null>> {
  await lockSignal(tx, input.signalId);
  const current = await tx.signals.findUnique({
    where: { id: input.signalId },
    select: { severity: true, severityCorrectedAt: true },
  });
  if (!current) throw new SignalNotFoundError(input.signalId);

  if (input.caller.kind === "pipeline") {
    if (current.severityCorrectedAt != null) {
      logRefusedWrite("severity", input.signalId, input.via ?? "writeSignalSeverity");
      return { refused: true, kept: current.severity };
    }
    await tx.signals.update({ where: { id: input.signalId }, data: { severity: input.severity } });
    return { refused: false, value: input.severity };
  }

  const caller = input.caller;
  if (caller.kind === "override") assertOverride(caller);
  const decidedAt = new Date();
  await tx.signals.update({
    where: { id: input.signalId },
    data: { severity: input.severity, severityCorrectedAt: decidedAt },
  });
  await recordDecision(tx, {
    ...(caller.kind === "override"
      ? {
          decider: { kind: "named", userId: caller.decidedBy },
          rationale: caller.rationale,
          supersedesId: (await latestDecision(tx, "signal", input.signalId, "SIGNAL_SEVERITY_SET"))?.id ?? null,
        }
      : { decider: { kind: "context", context: caller.context } }),
    decisionType: "SIGNAL_SEVERITY_SET",
    subjectType: "signal",
    subjectId: input.signalId,
    decidedAt,
    payload: { previousSeverity: current.severity, severity: input.severity },
  });
  return { refused: false, value: input.severity };
}

/**
 * A Signal's general location from the pipeline, a backfill script, or a
 * script's named override. A person in the app places a Signal through a
 * Location challenge decision, which writes origin, destination and countries
 * too, so there is no `person` kind here.
 */
export async function writeSignalLocation(
  tx: Tx,
  input: { signalId: string; locationId: string; caller: { kind: "pipeline" } | OverrideCaller; via?: string },
): Promise<DecidedFieldResult<string | null>> {
  const caller = input.caller;
  if (caller.kind === "override") assertOverride(caller);
  await lockSignal(tx, input.signalId);
  const current = await tx.signals.findUnique({
    where: { id: input.signalId },
    select: { locationId: true, originId: true, destinationId: true, locationCorrectedAt: true },
  });
  if (!current) throw new SignalNotFoundError(input.signalId);

  if (caller.kind === "override") {
    const decidedAt = new Date();
    await tx.signals.update({
      where: { id: input.signalId },
      data: {
        locationId: input.locationId,
        locationCorrectedAt: decidedAt,
        // As a first Location challenge decision does: keep what the pipeline
        // placed, so location precision (ADR-0012) measures the pipeline.
        ...(current.locationCorrectedAt == null
          ? { pipelineLocationId: current.locationId ?? current.originId ?? current.destinationId }
          : {}),
      },
    });
    await recordDecision(tx, {
      decider: { kind: "named", userId: caller.decidedBy },
      rationale: caller.rationale,
      supersedesId: (await latestDecision(tx, "signal", input.signalId, "SIGNAL_LOCATION_DECIDED"))?.id ?? null,
      decisionType: "SIGNAL_LOCATION_DECIDED",
      subjectType: "signal",
      subjectId: input.signalId,
      decidedAt,
      payload: { decision: "OVERRIDE", previousLocationId: current.locationId, appliedLocationId: input.locationId },
    });
    return { refused: false, value: input.locationId };
  }

  if (current.locationCorrectedAt != null) {
    logRefusedWrite("location", input.signalId, input.via ?? "writeSignalLocation");
    return { refused: true, kept: current.locationId };
  }
  await tx.signals.update({ where: { id: input.signalId }, data: { locationId: input.locationId } });
  return { refused: false, value: input.locationId };
}
