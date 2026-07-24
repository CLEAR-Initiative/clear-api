import { describe, it, expect } from "vitest";
import { renderPortalShell, renderPortalShellScript } from "../../src/portal/shell.js";

describe("Portal Shell", () => {
  describe("renderPortalShell", () => {
    it("renders Resources with Sandbox link after API Docs", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: { email: "test@example.com", role: "viewer" },
      });

      // Find Resources section (until Admin section or end of nav)
      const resourcesMatch = html.match(
        /Resources<\/div>([\s\S]*?)(?:<div class="nav-section">Admin|<\/nav>)/,
      );
      expect(resourcesMatch).toBeTruthy();

      const resourcesSection = resourcesMatch![1];
      const apiDocsIndex = resourcesSection.indexOf('href="/docs"');
      const sandboxIndex = resourcesSection.indexOf('href="/graphql"');

      expect(apiDocsIndex).toBeGreaterThan(-1);
      expect(sandboxIndex).toBeGreaterThan(-1);
      expect(sandboxIndex).toBeGreaterThan(apiDocsIndex); // Sandbox comes after API Docs
    });

    it("renders Sandbox link with target=_blank", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: null,
      });

      expect(html).toMatch(/href="\/graphql"[^>]*target="_blank"/);
      expect(html).toMatch(/href="\/graphql"[^>]*rel="noopener noreferrer"/);
    });

    it("renders Account footer when account is provided", () => {
      const html = renderPortalShell({
        surface: "portal",
        account: { email: "admin@example.com", role: "admin" },
      });

      expect(html).toContain("sidebar-footer");
      expect(html).toContain("admin@example.com");
      expect(html).toContain("Admin Account");
      expect(html).toContain("Sign Out");
    });

    it("does not render Account footer when account is null", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: null,
      });

      expect(html).not.toContain("sidebar-footer");
      expect(html).not.toContain("Sign Out");
    });

    it("renders tab buttons for portal surface", () => {
      const html = renderPortalShell({
        surface: "portal",
        account: { email: "test@example.com" },
      });

      expect(html).toMatch(/<button[^>]*data-tab="getting-started"/);
      expect(html).toMatch(/<button[^>]*data-tab="api-keys"/);
    });

    it("renders links for docs surface", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: { email: "test@example.com" },
      });

      expect(html).toMatch(/href="\/portal#getting-started"/);
      expect(html).toMatch(/href="\/portal#api-keys"/);
    });

    it("renders mobile drawer controls", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: null,
      });

      expect(html).toContain("mobile-menu-btn");
      expect(html).toContain("mobile-drawer-overlay");
      expect(html).toContain("toggleMobileDrawer");
    });

    it("keeps system status markup for the mobile menu", () => {
      const html = renderPortalShell({
        surface: "portal",
        account: null,
      });

      expect(html).toContain("system-status-inline");
      expect(html).toContain("System Operational");
    });
  });

  describe("renderPortalShellScript", () => {
    it("does not include confirm() in signOut function", () => {
      const script = renderPortalShellScript();

      expect(script).not.toContain("confirm(");
      expect(script).toContain("async function signOut()");
      expect(script).toContain("/api/auth/sign-out");
    });

    it("includes mobile drawer controls", () => {
      const script = renderPortalShellScript();

      expect(script).toContain("function openMobileDrawer()");
      expect(script).toContain("function closeMobileDrawer()");
    });

    it("uses sidebar-collapsed localStorage key", () => {
      const script = renderPortalShellScript();

      expect(script).toContain("localStorage.getItem('sidebar-collapsed')");
      expect(script).toContain("localStorage.setItem('sidebar-collapsed'");
    });
  });
});
