/**
 * Unit tests for `scrubEvent` in `src/utils/sentry.ts`, the `beforeSend` hook.
 *
 * `/webhooks/glitchtip?token=` carries its shared secret in the query string,
 * and the SDK attaches the request URL and query string to every event. The
 * hook must strip it (and auth headers) before the event reaches GlitchTip.
 */

import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://public@glitchtip.invalid/1";
});

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/node", () => ({ init, captureException: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { scrubEvent } from "../../src/utils/sentry.js";

type Ev = Parameters<typeof scrubEvent>[0];

describe("scrubEvent", () => {
  it("is installed as beforeSend", () => {
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ beforeSend: scrubEvent }));
  });

  it("redacts the token in the URL and the string query string", () => {
    const event = {
      request: {
        url: "https://api.example.org/webhooks/glitchtip?token=s3cret&x=1#frag",
        query_string: "token=s3cret&x=1",
      },
    } as Ev;
    const out = scrubEvent(event);
    expect(out.request?.url).toBe("https://api.example.org/webhooks/glitchtip?token=%5BFiltered%5D&x=1#frag");
    expect(out.request?.query_string).toBe("token=%5BFiltered%5D&x=1");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("redacts object and tuple query strings, case-insensitively", () => {
    const obj = scrubEvent({ request: { query_string: { Token: "a", page: "2" } } } as Ev);
    expect(obj.request?.query_string).toEqual({ Token: "[Filtered]", page: "2" });
    const tuples = scrubEvent({ request: { query_string: [["api_key", "b"], ["q", "c"]] } } as Ev);
    expect(tuples.request?.query_string).toEqual([["api_key", "[Filtered]"], ["q", "c"]]);
  });

  it("leaves URLs without secrets untouched and still drops auth headers", () => {
    const out = scrubEvent({
      request: {
        url: "https://api.example.org/graphql?full=true",
        query_string: "full=true",
        headers: { authorization: "Bearer x", cookie: "c=1", "user-agent": "ua" },
      },
    } as Ev);
    expect(out.request?.url).toBe("https://api.example.org/graphql?full=true");
    expect(out.request?.query_string).toBe("full=true");
    expect(out.request?.headers).toEqual({ "user-agent": "ua" });
  });

  it("passes events without a request through", () => {
    const event = { message: "m" } as Ev;
    expect(scrubEvent(event)).toBe(event);
  });
});
