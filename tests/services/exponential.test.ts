import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/env.js", () => ({
  env: {
    EXPONENTIAL_API_URL: "https://exponential.test",
    EXPONENTIAL_JWT: "test-jwt",
    EXPONENTIAL_WORKSPACE_ID: "ws_1",
  },
}));

const { findContactByEmail } = await import("../../src/services/exponential.js");

/** tRPC error envelope: `code` is the numeric JSON-RPC code, the string lives in `data.code`. */
function trpcError(status: number, numericCode: number, stringCode: string, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({
      error: { json: { message, code: numericCode, data: { code: stringCode, httpStatus: status } } },
    }),
  };
}

describe("exponential trpc client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a failure result (never throws) when Exponential rejects auth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(trpcError(401, -32001, "UNAUTHORIZED", "Authentication required.")),
    );

    const result = await findContactByEmail("someone@example.org");

    expect(result).toEqual({ ok: false, reason: "unauthorized:Authentication required." });
  });

  it("falls back to the HTTP status when the error body has no code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
    );

    const result = await findContactByEmail("someone@example.org");

    expect(result).toEqual({ ok: false, reason: "unknown:http_502" });
  });
});
