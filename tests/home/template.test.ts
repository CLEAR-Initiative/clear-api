import { describe, expect, it } from "vitest";
import { renderHomePage } from "../../src/home/template.js";

describe("renderHomePage", () => {
  it("exposes Sign in and a real GitHub link", () => {
    const html = renderHomePage();
    expect(html).toContain('href="/portal/login"');
    expect(html).toContain("Sign in");
    expect(html).toContain('href="https://github.com/CLEAR-Initiative"');
    expect(html).toContain("curl https://api.clearinitiative.io/graphql");
    expect(html).toContain('href="/favicon.ico"');
    expect(html).not.toContain("favicon.svg");
    expect(html).not.toContain("Access raw data items");
    expect(html).not.toContain("A single raw observation");
  });

  it("makes Contribute now the main call to action, top-right and in the hero", () => {
    const html = renderHomePage();
    expect(html).toContain(
      '<a href="/portal/login?next=%2Fportal%2Fwelcome" class="nav-cta">Contribute now</a>',
    );
    expect(html).toMatch(
      /<a href="\/portal\/login\?next=%2Fportal%2Fwelcome" class="btn btn-primary">Contribute now &rarr;<\/a>/,
    );
    expect(html).not.toContain("Get an API key");
    // The guide stays one click away from the hero.
    expect(html).toMatch(/class="hero-actions">[\s\S]*href="\/docs#guide"/);
  });
});
