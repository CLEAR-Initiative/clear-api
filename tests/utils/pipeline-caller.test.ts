import { describe, it, expect } from "vitest";
import { isPipelineCaller } from "../../src/utils/pipeline-caller.js";

describe("isPipelineCaller", () => {
  it("is true for an API key and false for a session or no credential", () => {
    expect(isPipelineCaller({ authMethod: "api-key" })).toBe(true);
    expect(isPipelineCaller({ authMethod: "session" })).toBe(false);
    expect(isPipelineCaller({ authMethod: null })).toBe(false);
  });
});

describe("isPipelineCaller with the pipeline identity (#430)", () => {
  it("is true for the pipeline role, whatever the credential", () => {
    expect(isPipelineCaller({ authMethod: "session", user: { role: "pipeline" } as never })).toBe(true);
    expect(isPipelineCaller({ authMethod: "api-key", user: { role: "pipeline" } as never })).toBe(true);
  });

  it("is false for a person's session", () => {
    expect(isPipelineCaller({ authMethod: "session", user: { role: "admin" } as never })).toBe(false);
  });
});
