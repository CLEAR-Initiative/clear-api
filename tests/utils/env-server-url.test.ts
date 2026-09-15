/**
 * Regression tests for `normaliseServerUrl`.
 *
 * The bug this guards: a deployment set `BETTER_AUTH_URL` to
 * `https://dev-api.clearinitiative.io/auth`. Nothing rejected it, and
 * every hand-built link inherited the stray segment — the emailed
 * password-reset link landed on `/auth/portal/reset-password`, a 404,
 * so nobody could complete a reset on that environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normaliseServerUrl } from "../../src/utils/env.js";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("normaliseServerUrl", () => {
  it("strips the path that broke the reset links", () => {
    expect(normaliseServerUrl("https://dev-api.clearinitiative.io/auth")).toBe(
      "https://dev-api.clearinitiative.io",
    );
  });

  it("warns so the bad value still gets fixed at source", () => {
    normaliseServerUrl("https://dev-api.clearinitiative.io/auth");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("BETTER_AUTH_URL");
  });

  it("leaves a bare origin alone, and says nothing about it", () => {
    expect(normaliseServerUrl("https://api.clearinitiative.io")).toBe(
      "https://api.clearinitiative.io",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a lone trailing slash as already-normal", () => {
    expect(normaliseServerUrl("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a non-default port", () => {
    expect(normaliseServerUrl("http://localhost:4000/auth/")).toBe(
      "http://localhost:4000",
    );
  });

  it("drops a query string or fragment too", () => {
    expect(normaliseServerUrl("https://api.example.com/?x=1")).toBe(
      "https://api.example.com",
    );
    expect(normaliseServerUrl("https://api.example.com/#frag")).toBe(
      "https://api.example.com",
    );
  });
});
