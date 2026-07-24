import { describe, it, expect } from "vitest";
import {
  PORTAL_PUBLIC_TABS,
  renderLoginPage,
  renderPortal,
} from "../../src/portal/template.js";

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
  });

  it("renders signed-in portal without login redirect in showTab", () => {
    const html = renderPortal({
      userEmail: "dev@example.com",
      userRole: "viewer",
    });

    expect(html).toContain("var PORTAL_AUTHED = true");
    expect(html).toContain("dev@example.com");
    expect(html).toContain("Sign Out");
  });

  it("honours a same-origin next path after login", () => {
    const html = renderLoginPage({ next: "/portal#api-keys" });
    expect(html).toContain('var LOGIN_NEXT = "/portal#api-keys"');
  });

  it("defaults first visitors to Create Account, not Sign In", () => {
    const html = renderLoginPage();
    expect(html).toMatch(/id="register-form"(?! style="display:none")/);
    expect(html).toMatch(/id="signin-form"[^>]*style="display:none"/);
    expect(html).toContain("Create Account");
  });

  it("rejects protocol-relative next paths", () => {
    const html = renderLoginPage({ next: "//evil.example/phish" });
    expect(html).toContain('var LOGIN_NEXT = "/portal"');
  });
});
