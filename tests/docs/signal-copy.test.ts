import { describe, expect, it } from "vitest";
import { renderDocsBody } from "../../src/docs/template.js";

describe("docs copy — signals are not raw payloads", () => {
  it("does not claim the API returns raw signal data", () => {
    const html = renderDocsBody({
      queries: [],
      mutations: [],
      types: [],
    });

    expect(html).not.toContain("Access raw data items");
    expect(html).not.toContain("raw observations underneath");
    expect(html).toContain("Upstream source payloads are not returned");
    expect(html).toContain("https://api.clearinitiative.io/graphql");
    expect(html).not.toContain("A single raw observation");
  });
});
