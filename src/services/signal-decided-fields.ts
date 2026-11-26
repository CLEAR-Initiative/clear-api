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
 * Each function locks the Signal row first, as the Location challenge
 * decision does, so a person's write and a pipeline write cannot interleave.
 */
import type { Prisma } from "../generated/prisma/client.js";
import type { Context } from "../context.js";
import { recordDecision } from "./decision-records.js";
import { createLogger } from "../utils/logger.js";

type Tx = Prisma.TransactionClient;

const log = createLogger("signal-decided-fields");

export type SignalFieldCaller =
  | { kind: "person"; context: Pick<Context, "user" | "authMethod" | "viaAgent"> }
  | { kind: "pipeline" };

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

  const decidedAt = new Date();
  await tx.signals.update({
    where: { id: input.signalId },
    data: { severity: input.severity, severityCorrectedAt: decidedAt },
  });
  await recordDecision(tx, {
    decider: { kind: "context", context: input.caller.context },
    decisionType: "SIGNAL_SEVERITY_SET",
    subjectType: "signal",
    subjectId: input.signalId,
    decidedAt,
    payload: { previousSeverity: current.severity, severity: input.severity },
  });
  return { refused: false, value: input.severity };
}

/**
 * A Signal's general location from the pipeline or a backfill script. A
 * person's location goes through a Location challenge decision, which writes
 * origin, destination and countries too, so it has no `person` kind here.
 */
export async function writeSignalLocation(
  tx: Tx,
  input: { signalId: string; locationId: string; caller: { kind: "pipeline" }; via?: string },
): Promise<DecidedFieldResult<string | null>> {
  await lockSignal(tx, input.signalId);
  const current = await tx.signals.findUnique({
    where: { id: input.signalId },
    select: { locationId: true, locationCorrectedAt: true },
  });
  if (!current) throw new SignalNotFoundError(input.signalId);

  if (current.locationCorrectedAt != null) {
    logRefusedWrite("location", input.signalId, input.via ?? "writeSignalLocation");
    return { refused: true, kept: current.locationId };
  }
  await tx.signals.update({ where: { id: input.signalId }, data: { locationId: input.locationId } });
  return { refused: false, value: input.locationId };
}
