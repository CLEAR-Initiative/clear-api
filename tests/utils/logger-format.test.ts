import { describe, expect, it } from "vitest";
import { usePrettyLogs } from "../../src/utils/logger.js";

describe("usePrettyLogs", () => {
  it("is pretty only on a terminal outside production", () => {
    expect(usePrettyLogs({ NODE_ENV: "development" }, true)).toBe(true);
    expect(usePrettyLogs({ NODE_ENV: "development" }, false)).toBe(false); // container
    expect(usePrettyLogs({ NODE_ENV: "production" }, true)).toBe(false);
  });

  it("LOG_FORMAT overrides the default either way", () => {
    expect(usePrettyLogs({ LOG_FORMAT: "pretty", NODE_ENV: "production" }, false)).toBe(true);
    expect(usePrettyLogs({ LOG_FORMAT: "json", NODE_ENV: "development" }, true)).toBe(false);
  });
});
