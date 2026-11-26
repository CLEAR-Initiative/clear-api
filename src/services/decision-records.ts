/**
 * The decision log (ADR-0024).
 *
 * `recordDecision` writes one DecisionRecord for one human judgement. It takes
 * a transaction client only, so the record and the change it records commit or
 * roll back together: if the record cannot be written, the change does not
 * happen. It takes the decider from the request context, never from an
 * argument, and refuses a pipeline caller: a system account never decides.
 *
 * Append-only: this module has no update or delete, and no other code may
 * write `decision_records` except through it. A later decision passes
 * `supersedesId`.
 *
 * Not the Activity log: mutations keep their best-effort `logActivity` call
 * for product analytics; this record is the one the pipeline must honour.
 */
import type { Prisma } from "../generated/prisma/client.js";
import type { DecisionType } from "../generated/prisma/enums.js";
import type { Context } from "../context.js";
import { isPipelineCaller } from "../utils/pipeline-caller.js";

type Tx = Prisma.TransactionClient;

/** Bumped when the meaning of a payload shape changes. */
export const DECISION_DEFINITION_VERSION = "decision-records-v1";

/** Types whose record must carry a rationale. Empty in V1 (#1289 fills it). */
export const RATIONALE_REQUIRED_TYPES: ReadonlySet<DecisionType> = new Set<DecisionType>();

export type DecisionSubjectType = "signal" | "case_proposal";

/** Who decided: a person from a request, or a named person behind an offline
 *  script's override. */
export type Decider =
  | { kind: "context"; context: Pick<Context, "user" | "authMethod" | "viaAgent"> }
  | { kind: "named"; userId: string };

export interface RecordDecisionInput {
  decider: Decider;
  decisionType: DecisionType;
  subjectType: DecisionSubjectType;
  subjectId: string;
  payload: Prisma.InputJsonValue;
  rationale?: string | null;
  evidenceCited?: Prisma.InputJsonValue | null;
  supersedesId?: string | null;
  decidedAt?: Date;
  correlationId?: string | null;
  clientRequestId?: string | null;
}

export class DecisionRecordError extends Error {}

function resolveDecider(decider: Decider): { decidedById: string; viaAgent: boolean } {
  if (decider.kind === "named") {
    if (!decider.userId) throw new DecisionRecordError("An override must name the person who decided");
    return { decidedById: decider.userId, viaAgent: false };
  }
  const { context } = decider;
  if (isPipelineCaller(context)) {
    throw new DecisionRecordError("A pipeline write is not a decision: no DecisionRecord is written for it");
  }
  if (!context.user) throw new DecisionRecordError("A decision needs a signed-in person");
  return { decidedById: context.user.id, viaAgent: context.viaAgent === true };
}

export async function recordDecision(tx: Tx, input: RecordDecisionInput) {
  const { decidedById, viaAgent } = resolveDecider(input.decider);
  const rationale = input.rationale?.trim() || null;
  if (RATIONALE_REQUIRED_TYPES.has(input.decisionType) && !rationale) {
    throw new DecisionRecordError(`A ${input.decisionType} decision needs a rationale`);
  }
  return tx.decisionRecords.create({
    data: {
      decisionType: input.decisionType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      decidedById,
      decidedAt: input.decidedAt ?? new Date(),
      viaAgent,
      rationale,
      evidenceCited: input.evidenceCited ?? undefined,
      payload: input.payload,
      supersedesId: input.supersedesId ?? null,
      correlationId: input.correlationId ?? null,
      clientRequestId: input.clientRequestId ?? null,
      definitionVersion: DECISION_DEFINITION_VERSION,
    },
  });
}

/** The latest record for a subject and type: what an override supersedes. */
export async function latestDecision(
  tx: Tx,
  subjectType: DecisionSubjectType,
  subjectId: string,
  decisionType: DecisionType,
) {
  return tx.decisionRecords.findFirst({
    where: { subjectType, subjectId, decisionType },
    orderBy: { sequence: "desc" },
  });
}
