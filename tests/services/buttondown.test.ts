import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNewsletterSubscriberCount } from "../../src/services/buttondown.js";

describe("fetchNewsletterSubscriberCount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not configured when the API key is absent", async () => {
    const result = await fetchNewsletterSubscriberCount(undefined);
    expect(result).toEqual({ configured: false, count: null });
  });

  it("returns the subscriber count on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ count: 42, next: null, previous: null, results: [] }),
      }),
    );

    const result = await fetchNewsletterSubscriberCount("test-key");
    expect(result).toEqual({ configured: true, count: 42 });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.buttondown.com/v1/subscribers?page=1",
      { headers: { Authorization: "Token test-key" } },
    );
  });

  it("returns an error state when Buttondown responds with a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    const result = await fetchNewsletterSubscriberCount("test-key");
    expect(result).toEqual({
      configured: true,
      count: null,
      error: "Buttondown API unavailable",
    });
  });

  it("returns an error state when the network call throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await fetchNewsletterSubscriberCount("test-key");
    expect(result).toEqual({
      configured: true,
      count: null,
      error: "Failed to fetch subscriber count",
    });
  });
});
