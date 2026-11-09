import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/env.js", () => ({
  env: {
    EXPONENTIAL_API_URL: "https://exponential.test",
    EXPONENTIAL_JWT: "test-jwt",
    EXPONENTIAL_WORKSPACE_ID: "ws_1",
    EXPONENTIAL_PROSPECTS_COLLECTION_ID: "col_prospects",
    EXPONENTIAL_APPROVED_COLLECTION_ID: "col_approved",
  },
}));

const { createContact, syncApprovedContact } = await import("../../src/services/exponential.js");

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

    const result = await createContact({ email: "someone@example.org" });

    expect(result).toEqual({ ok: false, reason: "unauthorized:Authentication required." });
  });

  it("stringifies a numeric code when the error has no data.code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { json: { message: "Authentication required.", code: -32001 } } }),
      }),
    );

    const result = await createContact({ email: "someone@example.org" });

    expect(result).toEqual({ ok: false, reason: "-32001:Authentication required." });
  });

  it("falls back to the HTTP status when the error body has no code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
    );

    const result = await createContact({ email: "someone@example.org" });

    expect(result).toEqual({ ok: false, reason: "unknown:http_502" });
  });

  it("syncApprovedContact creates the contact, then moves it into the approved collection", async () => {
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => ({ result: { data: { json } } }) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ id: "c1", email: "a@b.org", firstName: "A", lastName: null, wasExisting: false }))
      .mockResolvedValueOnce(ok({ added: 1 }))
      .mockResolvedValueOnce(ok({ id: "c1" }))
      .mockResolvedValueOnce(ok({ removed: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncApprovedContact({ email: "a@b.org", firstName: "A" });

    expect(result).toEqual({ ok: true, value: { contactId: "c1", warnings: [] } });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      procedure: String(url).split("/api/trpc/")[1],
      body: JSON.parse(init.body).json,
    }));
    expect(calls.map((c) => c.procedure)).toEqual([
      "crmApi.contactCreate",
      "collection.addMembers",
      "crmApi.contactUpdate",
      "collection.removeMember",
    ]);
    expect(calls[0].body).toMatchObject({ email: "a@b.org", profileType: "clear_approved" });
    expect(calls[1].body).toMatchObject({ collectionId: "col_approved", memberIds: ["c1"] });
    expect(calls[3].body).toMatchObject({ collectionId: "col_prospects", memberId: "c1" });
  });

  it("syncApprovedContact stops before touching collections when the contact can't be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncApprovedContact({ email: "a@b.org" });

    expect(result).toEqual({ ok: false, reason: "contact_upsert_failed:network_error:boom" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
