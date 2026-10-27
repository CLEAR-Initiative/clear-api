import { describe, it, expect } from "vitest";
import {
  portalShellCss,
  renderPortalShell,
  renderPortalShellScript,
  renderPortalShellStyles,
  renderPortalShellStylesheetLink,
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
      expect(html).toContain("signin-icon");
      expect(html).toContain("signin-label");
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

    describe("Welcome item", () => {
      const menuOf = (html: string) =>
        html.match(/Menu<\/div>([\s\S]*?)<div class="nav-section">Resources/)![1];

      it.each(["portal", "docs", "admin", "welcome"] as const)(
        "is first in Menu for signed-in users on the %s surface",
        (surface) => {
          for (const role of ["pending", "member", "admin"]) {
            const menu = menuOf(
              renderPortalShell({ surface, account: { email: "a@b.dev", role } }),
            );
            const welcome = menu.indexOf('href="/portal/welcome"');
            expect(welcome).toBeGreaterThan(-1);
            expect(welcome).toBeLessThan(menu.indexOf("Getting Started"));
          }
        },
      );

      it.each(["portal", "docs"] as const)("is hidden from anonymous visitors (%s)", (surface) => {
        const html = renderPortalShell({ surface, account: null });
        expect(html).not.toContain("/portal/welcome");
        expect(html).not.toContain(">Welcome<");
      });

      it("is marked current on the Welcome page", () => {
        const html = renderPortalShell({
          surface: "welcome",
          account: { email: "a@b.dev", role: "pending" },
          activeHref: "/portal/welcome",
        });
        expect(html).toMatch(/href="\/portal\/welcome" class="nav-item nav-item--link active"[^>]*aria-current="page"/);
      });
    });

    describe("pending approval", () => {
      it.each(["portal", "welcome"] as const)(
        "locks API Keys and Usage Analytics but keeps them visible (%s)",
        (surface) => {
          const html = renderPortalShell({
            surface,
            account: { email: "a@b.dev", role: "pending" },
          });
          const locked = html.match(/<div class="nav-item nav-item--locked"[\s\S]*?<\/div>/g) ?? [];
          expect(locked).toHaveLength(2);
          expect(locked[0]).toContain("API Keys");
          expect(locked[1]).toContain("Usage Analytics");
          for (const item of locked) {
            expect(item).toContain('aria-disabled="true"');
            expect(item).toContain("Available once your account is approved");
          }
          // Not reachable as a tab or link
          expect(html).not.toContain('data-tab="api-keys"');
          expect(html).not.toContain('href="/portal#api-keys"');
          expect(html).not.toContain('data-tab="usage-analytics"');
          expect(html).not.toContain('href="/portal#usage-analytics"');
        },
      );

      it("leaves the public items as they are for anonymous visitors", () => {
        const pending = renderPortalShell({ surface: "welcome", account: { email: "a@b.dev", role: "pending" } });
        for (const href of ['href="/portal#getting-started"', 'href="/portal#reference"', 'href="/docs"', 'href="/graphql"']) {
          expect(pending).toContain(href);
        }
      });

      it("does not lock anything for approved users or anonymous visitors", () => {
        for (const account of [null, { email: "a@b.dev", role: "member" }]) {
          const html = renderPortalShell({ surface: "docs", account });
          expect(html).not.toContain("nav-item--locked");
          expect(html).toContain('href="/portal#api-keys"');
        }
      });
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

    it("keeps system status markup inline with the version", () => {
      const html = renderPortalShell({
        surface: "portal",
        account: null,
      });

      expect(html).toContain("sidebar-meta");
      expect(html).toContain("system-status-inline");
      expect(html).toContain("System Operational");
      expect(html).toMatch(
        /sidebar-meta[\s\S]*system-status-inline[\s\S]*version-indicator/,
      );
    });

    it("nests admin destinations under Admin Panel for mobile", () => {
      const admin = renderPortalShell({
        surface: "admin",
        account: { email: "admin@example.com", role: "admin" },
        activeHref: "/portal/admin",
        adminTab: "users",
        pendingCount: 3,
      });

      expect(admin).toContain("nav-sub--admin");
      expect(admin).toContain('href="/portal/admin?tab=dashboard"');
      expect(admin).toContain('href="/portal/admin?tab=organisations"');
      expect(admin).toContain('href="/portal/admin?tab=users"');
      expect(admin).toContain('href="/portal/admin?tab=webhooks"');
      expect(admin).toContain("nav-sub-badge");
      expect(admin).toMatch(
        /href="\/portal\/admin\?tab=users"[^>]*nav-item--sub active/,
      );

      const viewer = renderPortalShell({
        surface: "portal",
        account: { email: "viewer@example.com", role: "viewer" },
      });
      expect(viewer).not.toContain("nav-sub--admin");
      expect(viewer).not.toContain("Admin Panel");
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

    it("includes custom select enhancement and role-form save", () => {
      const script = renderPortalShellScript();

      expect(script).toContain("enhancePortalSelects");
      expect(script).toContain("select.field-select");
      expect(script).toContain("bindRoleForms");
      expect(script).toContain("data-stored");
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
    it("shows compact status and admin sub-nav only on mobile", () => {
      const css = renderPortalShellStyles();

      expect(css).toContain(".sidebar-meta");
      expect(css).toMatch(/\.system-status-inline \{[^}]*border:\s*none/);
      expect(css).toMatch(/\.status-text \{[^}]*font-size:\s*0\.65rem/);
      expect(css).not.toMatch(/\.status-text \{[^}]*clip:/);
      expect(css).toMatch(/\.nav-sub \{[^}]*display:\s*none/);
      expect(css).toMatch(
        /@media \(max-width: 768px\) \{[\s\S]*?\.nav-sub \{[\s\S]*?display:\s*flex/,
      );
    });

    it("keeps the closed mobile overlay from eating clicks", () => {
      const css = renderPortalShellStyles();
      expect(css).toMatch(
        /\.mobile-drawer-overlay \{[^}]*pointer-events:\s*none/,
      );
      expect(css).toMatch(
        /\.mobile-drawer-overlay\.active \{[^}]*pointer-events:\s*auto/,
      );
    });

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

    it("gives the collapsed sign-in control a square icon button with margin", () => {
      const css = renderPortalShellStyles();

      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-footer \{[^}]*padding:\s*16px;/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed \.sidebar-footer \{[^}]*align-items:\s*center/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed a\.signin-link \{[^}]*width:\s*40px;/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed a\.signin-link \{[^}]*height:\s*40px;/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed a\.signin-link \{[^}]*min-height:\s*40px;/,
      );
      expect(css).toMatch(
        /\.portal-shell\.sidebar-collapsed a\.signin-link \.signin-label \{[^}]*opacity:\s*0/,
      );
      expect(css).toMatch(
        /@media \(max-width: 768px\) \{[\s\S]*?\.portal-shell\.sidebar-collapsed a\.signin-link \.signin-label \{[^}]*opacity:\s*1/,
      );
      expect(css).toMatch(
        /@media \(max-width: 768px\) \{[\s\S]*?\.portal-shell\.sidebar-collapsed a\.signin-link \{[^}]*width:\s*auto/,
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

    it("exposes a cache-busted stylesheet link instead of requiring inline CSS", () => {
      const link = renderPortalShellStylesheetLink();
      expect(link).toMatch(
        /<link rel="stylesheet" href="\/css\/portal-shell\.css\?v=/,
      );
      expect(portalShellCss()).toContain("--sidebar-width: 288px");
      expect(portalShellCss()).not.toContain("<style>");
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
