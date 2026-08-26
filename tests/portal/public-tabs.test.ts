import { describe, it, expect } from "vitest";
import {
  PORTAL_PUBLIC_TABS,
  renderLoginPage,
  renderPortal,
  safePortalNext,
} from "../../src/portal/template.js";
import { renderPortalShell } from "../../src/portal/shell.js";

describe("Portal public vs auth-gated tabs", () => {
  it("exposes Getting Started and API Reference as public tabs", () => {
    expect(PORTAL_PUBLIC_TABS).toEqual(["getting-started", "reference"]);
  });

  it("renders anonymous portal with auth gate + public defaults", () => {
    const html = renderPortal({ userEmail: null });

    expect(html).toContain("var PORTAL_AUTHED = false");
    expect(html).toContain("/portal/login?next=");
    expect(html).toContain("getting-started");
    expect(html).toContain("PORTAL_AUTHED ? 'api-keys' : 'getting-started'");
    expect(html).not.toContain("Sign Out");
    expect(html).toContain('href="/portal/login"');
    expect(html).toContain("Sign in");
    expect(html).toMatch(/getting-started-ctas[\s\S]*Sign in/);
    expect(html).not.toContain("Manage API Keys");
  });

  it("renders signed-in portal without login redirect in showTab", () => {
    const html = renderPortal({
      userEmail: "dev@example.com",
      userRole: "viewer",
    });

    expect(html).toContain("var PORTAL_AUTHED = true");
    expect(html).toContain("dev@example.com");
    expect(html).toContain("Sign Out");
    expect(html).toContain("Manage API Keys");
  });

  it("honours allowlisted portal/docs next paths after login", () => {
    expect(safePortalNext("/portal#api-keys")).toBe("/portal#api-keys");
    expect(safePortalNext("/docs#guide")).toBe("/docs#guide");
    const html = renderLoginPage({ next: "/portal#api-keys" });
    expect(html).toContain('var LOGIN_NEXT = "/portal#api-keys"');
  });

  it("defaults first visitors to Create Account, not Sign In", () => {
    const html = renderLoginPage();
    expect(html).toMatch(/id="register-form"(?! style="display:none")/);
    expect(html).toMatch(/id="signin-form"[^>]*style="display:none"/);
    expect(html).toContain("Create Account");
  });

  it("rejects open-redirect tricks for login next", () => {
    expect(safePortalNext("//evil.example/phish")).toBe("/portal");
    expect(safePortalNext("/\\evil.example")).toBe("/portal");
    expect(safePortalNext("/graphql")).toBe("/portal");
    expect(safePortalNext("https://evil.example")).toBe("/portal");
    const html = renderLoginPage({ next: "//evil.example/phish" });
    expect(html).toContain('var LOGIN_NEXT = "/portal"');
  });

  it("escapes tab names in portal nav onclick handlers", () => {
    const html = renderPortalShell({
      surface: "portal",
      account: { email: "dev@example.com" },
    });
    // Hardcoded tabs should render as safe JS string literals in the attribute
    expect(html).toContain('onclick="showTab(&quot;getting-started&quot;)"');
    expect(html).not.toMatch(/onclick="showTab\('/);
  });
});
