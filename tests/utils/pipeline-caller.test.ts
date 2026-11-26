import { describe, it, expect } from "vitest";
import { isPipelineCaller } from "../../src/utils/pipeline-caller.js";

describe("isPipelineCaller", () => {
  it("is true for an API key and false for a session or no credential", () => {
    expect(isPipelineCaller({ authMethod: "api-key" })).toBe(true);
    expect(isPipelineCaller({ authMethod: "session" })).toBe(false);
    expect(isPipelineCaller({ authMethod: null })).toBe(false);
  });
});
