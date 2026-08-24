import { describe, expect, it } from "vitest";
import { renderHomePage } from "../../src/home/template.js";

describe("renderHomePage", () => {
  it("exposes Sign in and a real GitHub link", () => {
    const html = renderHomePage();
    expect(html).toContain('href="/portal/login"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="https://github.com/CLEAR-Initiative"');
    expect(html).toContain("curl https://api.clearinitiative.io/graphql");
    expect(html).not.toContain("Access raw data items");
    expect(html).not.toContain("A single raw observation");
  });
});
