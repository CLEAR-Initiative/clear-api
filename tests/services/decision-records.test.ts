import { describe, it, expect, vi } from "vitest";
import { recordDecision, DecisionRecordError } from "../../src/services/decision-records.js";

const tx = () => ({ decisionRecords: { create: vi.fn(async ({ data }: { data: object }) => data) } });
const base = {
  decisionType: "SIGNAL_SEVERITY_SET" as const,
  subjectType: "signal" as const,
  subjectId: "s1",
  payload: {},
};
const person = (extra: object = {}) =>
  ({ user: { id: "u1", role: "member" }, authMethod: "session", viaAgent: false, ...extra }) as never;

describe("recordDecision", () => {
  it("takes the decider and the Agent mark from the context", async () => {
    const t = tx();
    await recordDecision(t as never, { ...base, decider: { kind: "context", context: person({ viaAgent: true }) } });
    expect(t.decisionRecords.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decidedById: "u1", viaAgent: true, definitionVersion: "decision-records-v1" }),
    });
  });

  it("refuses a pipeline caller: a system account never decides", async () => {
    const t = tx();
    await expect(
      recordDecision(t as never, { ...base, decider: { kind: "context", context: person({ authMethod: "api-key" }) } }),
    ).rejects.toBeInstanceOf(DecisionRecordError);
    expect(t.decisionRecords.create).not.toHaveBeenCalled();
  });

  it("refuses a request with no signed-in person, and an override with no named person", async () => {
    const t = tx();
    await expect(
      recordDecision(t as never, { ...base, decider: { kind: "context", context: person({ user: null }) } }),
    ).rejects.toBeInstanceOf(DecisionRecordError);
    await expect(recordDecision(t as never, { ...base, decider: { kind: "named", userId: "" } })).rejects.toBeInstanceOf(
      DecisionRecordError,
    );
    expect(t.decisionRecords.create).not.toHaveBeenCalled();
  });
});
