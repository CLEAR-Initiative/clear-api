import { describe, it, expect } from "vitest";
import {
  renderPortalShell,
  renderPortalShellScript,
  renderPortalShellStyles,
  renderPortalToast,
} from "../../src/portal/shell.js";

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
      expect(html).toContain("/portal/icons/clearapi_logo.png");
      expect(html).not.toContain("/portal/icons/logo.png");
    });

    it("renders a Sign in CTA when account is null", () => {
      const html = renderPortalShell({
        surface: "docs",
        account: null,
      });

      expect(html).toContain("sidebar-footer");
      expect(html).toContain('href="/portal/login"');
      expect(html).toContain("Sign in");
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

    it("includes custom select enhancement", () => {
      const script = renderPortalShellScript();

      expect(script).toContain("enhancePortalSelects");
      expect(script).toContain("select.field-select");
    });

    it("dismisses a portal toast after 2 seconds", () => {
      const script = renderPortalShellScript();

      expect(script).toContain("dismissPortalToast");
      expect(script).toContain(".portal-toast");
      expect(script).toContain("2000");
      expect(script).toContain("is-leaving");
    });
  });

  describe("renderPortalShellStyles", () => {
    it("lets the collapsed sidebar chevron overflow above main content", () => {
      const css = renderPortalShellStyles();

      expect(css).toContain(
        ".portal-shell.sidebar-collapsed .sidebar-toggle",
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-toggle[\s\S]*?z-index:\s*250/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar \{[\s\S]*?overflow:\s*visible/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-top \{[\s\S]*?overflow:\s*visible/,
      );
    });

    it("keeps nav icons left-aligned with a tighter collapsed inset", () => {
      const css = renderPortalShellStyles();

      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-top \{[^}]*padding:\s*32px 12px 0;/,
      );
      expect(css).not.toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-top \{[^}]*gap:\s*24px/,
      );
      expect(css).not.toMatch(
        /\.portal-shell\.sidebar-collapsed \.nav-section \{[^}]*height:\s*0/,
      );
      expect(css).not.toMatch(
        /\.portal-shell\.sidebar-collapsed \.nav-item \{[^}]*justify-content:\s*center/,
      );
      expect(css).not.toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-brand \{[^}]*justify-content:\s*center/,
      );
      expect(css).not.toMatch(
        /\.portal-shell\.sidebar-collapsed \.brand-logo-img \{[^}]*margin:\s*0 auto/,
      );
      expect(css).toMatch(/\.nav-item \{[^}]*min-height:\s*calc\(20px \+ 1\.6em\)/);
      expect(css).toMatch(/\.sidebar-brand \{[^}]*min-height:\s*44px/);
    });

    it("includes shared field and custom-select control styles", () => {
      const css = renderPortalShellStyles();

      expect(css).toContain("--control-height: 2.5rem");
      expect(css).toContain(".field-select");
      expect(css).toContain(".select-menu");
      expect(css).toContain("z-index: 280");
    });

    it("styles a bottom-right toast that animates in and out", () => {
      const css = renderPortalShellStyles();

      expect(css).toContain(".portal-toast");
      expect(css).toContain("bottom: max(1.25rem, env(safe-area-inset-bottom))");
      expect(css).toContain("right: max(1.25rem, env(safe-area-inset-right))");
      expect(css).toContain("portal-toast-in");
      expect(css).toContain("portal-toast-out");
    });
  });

  describe("renderPortalToast", () => {
    it("renders an escaped success toast", () => {
      const html = renderPortalToast({
        kind: "success",
        message: 'Created "Acme".',
      });

      expect(html).toContain('class="portal-toast portal-toast--success"');
      expect(html).toContain("Created &quot;Acme&quot;.");
      expect(html).toContain('role="status"');
    });
  });
});
