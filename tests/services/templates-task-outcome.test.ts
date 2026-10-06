/**
 * The taskOutcome email (ADR-0010, V2): subject, the one-line outcome, the
 * Event link, and the error only when the caller passed one.
 */
import { describe, expect, it } from "vitest";
import { taskOutcome } from "../../src/services/messaging/templates.js";

describe("taskOutcome email", () => {
  it("renders a completion with the Event link and no error block", () => {
    const content = taskOutcome("Ana", "Impact prior proposed — review it", "https://app.test/event/ev-1", {
      outcomeKind: "completed",
      error: null,
    });
    expect(content.subject).toBe("CLEAR: Impact prior proposed — review it");
    expect(content.textBody).toContain("Hi Ana");
    expect(content.textBody).toContain("https://app.test/event/ev-1");
    expect(content.textBody).not.toContain("Error:");
    expect(content.htmlBody).toContain("Enrichment ready for review");
    expect(content.htmlBody).toContain('href="https://app.test/event/ev-1"');
    expect(content.htmlBody).not.toContain("Error:");
  });

  it("renders a failure with the error for a recipient allowed to see it", () => {
    const content = taskOutcome("Ana", "Impact prior enrichment failed", "https://app.test/event/ev-1", {
      outcomeKind: "failed",
      error: "model timed out",
    });
    expect(content.subject).toContain("failed");
    expect(content.textBody).toContain("Error: model timed out");
    expect(content.htmlBody).toContain("Enrichment failed");
    expect(content.htmlBody).toContain("model timed out");
  });
});
