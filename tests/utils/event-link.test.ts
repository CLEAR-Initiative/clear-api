import { describe, it, expect } from "vitest";
import { eventLink, withLinkSource } from "../../src/utils/event-link.js";

describe("withLinkSource", () => {
  it("adds from to a bare path", () => {
    expect(withLinkSource("/event/e1", "inbox")).toBe("/event/e1?from=inbox");
  });
  it("keeps an existing query string", () => {
    expect(withLinkSource("https://app.x/event/e1?tab=map", "email")).toBe(
      "https://app.x/event/e1?tab=map&from=email",
    );
  });
  it("replaces an existing from rather than duplicating it", () => {
    expect(withLinkSource("/event/e1?from=email&a=1", "sms")).toBe(
      "/event/e1?from=sms&a=1",
    );
  });
  it("keeps the fragment after the query", () => {
    expect(withLinkSource("/event/e1#signals", "webhook")).toBe(
      "/event/e1?from=webhook#signals",
    );
  });
});

describe("eventLink", () => {
  it("builds an absolute link and trims a trailing slash on the base", () => {
    expect(eventLink("e1", "email", "https://app.x/")).toBe(
      "https://app.x/event/e1?from=email",
    );
  });
  it("builds a relative actionUrl without a base", () => {
    expect(eventLink("e1", "inbox")).toBe("/event/e1?from=inbox");
  });
});
