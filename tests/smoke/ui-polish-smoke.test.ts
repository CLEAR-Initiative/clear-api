import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeDocsPage } from "../../src/docs/template.js";
import { renderHomePage } from "../../src/home/template.js";
import {
  renderPortalShell,
  renderPortalShellScript,
  renderPortalShellStyles,
  renderPortalToast,
} from "../../src/portal/shell.js";
import {
  renderAdminMetrics,
  renderAdminOrganisations,
  renderAdminOrgDetail,
  renderAdminUsers,
  renderAdminWebhookDetail,
  renderAdminWebhookNew,
  renderAdminWebhooksList,
  renderLoginPage,
  renderPortal,
  renderResetPasswordPage,
  renderWaitingForApproval,
} from "../../src/portal/template.js";

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function assertSharedChrome(html: string) {
  expect(html).toContain('href="/favicon.ico"');
  expect(html).toContain('href="/apple-touch-icon.png"');
  expect(html).toContain('href="/site.webmanifest"');
  expect(html).not.toContain("favicon.svg");
}

const metrics = {
  engagement: {
    dau: 1,
    mau: 5,
    totalUsers: 10,
    usersByRole: { admin: 1, analyst: 2, viewer: 6, pending: 1 },
  },
  content: { signals: 100, events: 20, publishedAlerts: 3, crises: 2 },
  org: { organisations: 4, teams: 8 },
  newsletter: { configured: true, count: 12 },
};

describe("UI polish smoke", () => {
  describe("public assets", () => {
    it("ships favicon, touch icons, manifest, and the portal logo", () => {
      const root = process.cwd();
      for (const rel of [
        "public/favicon.ico",
        "public/apple-touch-icon.png",
        "public/android-chrome-192x192.png",
        "public/android-chrome-512x512.png",
        "public/site.webmanifest",
        "public/portal/icons/clearapi_logo.png",
      ]) {
        expect(existsSync(join(root, rel)), rel).toBe(true);
      }
      expect(existsSync(join(root, "public/favicon.svg"))).toBe(false);
    });
  });

  describe("sidebar collapse polish", () => {
    const css = renderPortalShellStyles();
    const script = renderPortalShellScript();

    it("locks vertical metrics and uses a tighter left inset without centering", () => {
      expect(cssBlock(css, ".portal-shell.sidebar-collapsed .sidebar-top")).toContain(
        "padding: 32px 12px 0",
      );
      expect(cssBlock(css, ".portal-shell.sidebar-collapsed .sidebar-top")).not.toContain(
        "gap: 24px",
      );
      expect(cssBlock(css, ".portal-shell.sidebar-collapsed .nav-section")).not.toContain(
        "height: 0",
      );
      expect(cssBlock(css, ".portal-shell.sidebar-collapsed .nav-item")).not.toContain(
        "justify-content: center",
      );
      expect(cssBlock(css, ".portal-shell.sidebar-collapsed .sidebar-brand")).not.toContain(
        "justify-content: center",
      );
      expect(cssBlock(css, ".nav-item")).toContain("min-height: calc(20px + 1.6em)");
      expect(cssBlock(css, ".sidebar-brand")).toContain("min-height: 44px");
    });

    it("persists collapse in localStorage and restores on load", () => {
      expect(script).toContain("localStorage.getItem('sidebar-collapsed')");
      expect(script).toContain("localStorage.setItem('sidebar-collapsed'");
      expect(script).toContain("function toggleSidebar()");
    });
  });

  describe("toast polish", () => {
    const css = renderPortalShellStyles();
    const script = renderPortalShellScript();

    it("anchors toasts bottom-right and auto-dismisses after 2s", () => {
      expect(cssBlock(css, ".portal-toast")).toContain("position: fixed");
      expect(cssBlock(css, ".portal-toast")).toContain("bottom:");
      expect(cssBlock(css, ".portal-toast")).toContain("right:");
      expect(css).toContain("portal-toast-in");
      expect(css).toContain("portal-toast-out");
      expect(script).toContain("dismissPortalToast");
      expect(script).toContain("2000");
      expect(script).toContain("params.delete('flash')");
      expect(script).toContain("params.delete('msg')");
      expect(script).toContain("history.replaceState");
    });

    it("renders success and error toasts", () => {
      expect(renderPortalToast({ kind: "success", message: "Saved." })).toContain(
        "portal-toast--success",
      );
      expect(renderPortalToast({ kind: "error", message: "Nope." })).toContain(
        "portal-toast--error",
      );
    });
  });

  describe("surfaces and buttons", () => {
    it("home exposes marketing CTAs and chrome", () => {
      const html = renderHomePage();
      assertSharedChrome(html);
      expect(html).toContain('href="/portal/login"');
      expect(html).toContain("Sign in");
      expect(html).toContain('href="/docs"');
      expect(html).toContain('href="/graphql"');
      expect(html).toContain('href="https://github.com/CLEAR-Initiative"');
    });

    it("login has create-account and sign-in controls", () => {
      const html = renderLoginPage({ next: "/portal#api-keys" });
      assertSharedChrome(html);
      expect(html).toContain("Create Account");
      expect(html).toContain("signin-form");
      expect(html).toContain("register-form");
      expect(html).toContain("/api/auth/sign-in/email");
      expect(html).toContain("/api/auth/sign-up/email");
      expect(html).toContain("/portal/forgot-password");
    });

    it("password reset submits and links back to the portal", () => {
      const html = renderResetPasswordPage({
        token: "tok_1",
        kind: "reset",
        tokenValid: true,
      });
      assertSharedChrome(html);
      expect(html).toContain("Reset Password");
      expect(html).toContain('onclick="submitReset()"');
      expect(html).toContain('href="/portal"');
    });

    it("pending-approval page can sign out", () => {
      const html = renderWaitingForApproval({ userEmail: "new@example.com" });
      assertSharedChrome(html);
      expect(html).toContain("new@example.com");
      expect(html).toContain("/api/auth/sign-out");
      expect(html).toContain("Sign out");
      expect(html).toContain('class="docs-link"');
      expect(html).toContain('href="/docs"');
    });

    it("anonymous portal keeps public tabs and a sign-in CTA", () => {
      const html = renderPortal({ userEmail: null });
      assertSharedChrome(html);
      expect(html).toContain('href="/portal/login"');
      expect(html).toContain("Sign in");
      expect(html).toContain("getting-started");
      expect(html).toContain("data-tab=\"api-keys\"");
      expect(html).toContain('href="/docs"');
      expect(html).toContain('href="/graphql"');
      expect(html).toContain("toggleSidebar");
      expect(html).toContain("/portal/icons/clearapi_logo.png");
      expect(html).not.toContain("Sign Out");
      expect(html).not.toContain("Admin Panel");
    });

    it("signed-in portal exposes keys, sign-out, and admin for admins", () => {
      const viewer = renderPortal({
        userEmail: "dev@example.com",
        userRole: "viewer",
      });
      expect(viewer).toContain("Sign Out");
      expect(viewer).toContain("Manage API Keys");
      expect(viewer).not.toContain("Admin Panel");

      const admin = renderPortal({
        userEmail: "admin@example.com",
        userRole: "admin",
      });
      expect(admin).toContain("Admin Panel");
      expect(admin).toContain('href="/portal/admin"');
    });

    it("docs shell includes portal nav, TOC, and sandbox in a new tab", () => {
      const html = composeDocsPage({
        bodyHtml: "<h2 id='guide'>Guide</h2>",
        account: { email: "dev@example.com", role: "viewer" },
        types: [{ name: "Alert", kind: "object", description: "", fields: [], enumValues: [] }],
        mutations: [],
      });
      assertSharedChrome(html);
      expect(html).toContain("portal-shell");
      expect(html).toContain("docs-toc");
      expect(html).toContain("On This Page");
      expect(html).toContain('href="/graphql"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain("Sign Out");
      expect(html).toContain("/portal/icons/clearapi_logo.png");
    });
  });

  describe("admin buttons and persistence", () => {
    it("dashboard, users, orgs, and webhook pages share shell + toast CSS", () => {
      const pages = [
        renderAdminMetrics({
          currentUserEmail: "admin@clear.dev",
          pendingCount: 2,
          metrics,
        }),
        renderAdminUsers({
          currentUserEmail: "admin@clear.dev",
          pendingCount: 1,
          users: [
            {
              id: "u-pending",
              name: "New Dev",
              email: "new@example.com",
              role: "pending",
              createdAt: new Date("2026-08-18"),
              organisations: [],
            },
          ],
        }),
        renderAdminOrganisations({
          currentUserEmail: "admin@clear.dev",
          pendingCount: 0,
          organisations: [],
        }),
        renderAdminWebhooksList({
          currentUserEmail: "admin@clear.dev",
          pendingCount: 0,
          rows: [],
        }),
      ];

      for (const html of pages) {
        assertSharedChrome(html);
        expect(html).toContain("portal-toast");
        expect(html).toContain("toggleSidebar");
        expect(html).toContain("/portal/admin?tab=dashboard");
        expect(html).toContain("/portal/admin?tab=users");
        expect(html).toContain("/portal/admin?tab=organisations");
        expect(html).toContain("/portal/admin?tab=webhooks");
        expect(html).toContain("Sign Out");
      }
    });

    it("users approve posts to the admin approve action", () => {
      const html = renderAdminUsers({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 1,
        users: [
          {
            id: "u-pending",
            name: "New Dev",
            email: "new@example.com",
            role: "pending",
            createdAt: new Date("2026-08-18"),
            organisations: [],
          },
        ],
      });
      expect(html).toContain('action="/portal/admin/approve"');
      expect(html).toContain("btn-approve");
    });

    it("org list and detail expose every mutating form action", () => {
      const list = renderAdminOrganisations({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
        organisations: [],
      });
      expect(list).toContain('action="/portal/admin/orgs/create"');

      const detail = renderAdminOrgDetail({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
        defaultInviteOrgRole: "org_admin",
        org: {
          id: "org_1",
          name: "Acme",
          slug: "acme",
          isActive: true,
          createdAt: new Date("2026-01-15"),
          importableTeams: [],
          teams: [
            {
              id: "team_1",
              name: "Ops",
              slug: "ops",
              description: null,
              members: [
                {
                  userId: "user_1",
                  email: "lead@acme.dev",
                  name: "Lead",
                  teamRole: "team_admin",
                },
              ],
            },
          ],
          members: [
            {
              userId: "user_1",
              email: "lead@acme.dev",
              name: "Lead",
              globalRole: "viewer",
              orgRole: "org_admin",
              joinedAt: new Date("2026-01-16"),
            },
          ],
        },
      });

      for (const action of [
        "/portal/admin/orgs/update",
        "/portal/admin/orgs/invite",
        "/portal/admin/orgs/members/role",
        "/portal/admin/orgs/members/name",
        "/portal/admin/orgs/members/remove",
        "/portal/admin/orgs/teams/create",
        "/portal/admin/orgs/teams/members/add",
        "/portal/admin/orgs/teams/members/role",
        "/portal/admin/orgs/teams/delete",
      ]) {
        expect(detail).toContain(`action="${action}"`);
      }
    });

    it("webhook list, create, and detail expose manage/create/update/test/rotate/delete/retry", () => {
      const list = renderAdminWebhooksList({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
        rows: [
          {
            id: "wh_1",
            name: "Slack",
            targetUrl: "https://example.com/hook",
            active: true,
            eventTypeFilter: [],
            createdAt: new Date("2026-01-15"),
            deliveryCount: 3,
            deadCount: 1,
          },
        ],
      });
      expect(list).toContain("/portal/admin/webhooks/new");
      expect(list).toContain("/portal/admin/webhooks/wh_1");
      expect(list).toContain("Manage");

      const create = renderAdminWebhookNew({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
      });
      expect(create).toContain('action="/portal/admin/webhooks/create"');
      expect(create).toContain("Create route");

      const detail = renderAdminWebhookDetail({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
        subscription: {
          id: "wh_1",
          name: "Slack",
          targetUrl: "https://example.com/hook",
          active: true,
          eventTypeFilter: ["issue.new"],
          createdAt: new Date("2026-01-15"),
          deliveryCount: 2,
          deadCount: 1,
          revealedSecret: null,
          secretPrefix: "whsec_ab",
        },
        deliveries: [
          {
            id: "del_1",
            eventId: "evt_deadletter1",
            eventType: "issue.new",
            attemptNumber: 5,
            responseStatus: 500,
            error: "timeout",
            succeededAt: null,
            nextRetryAt: null,
            createdAt: new Date("2026-01-16"),
            status: "dead",
          },
        ],
      });
      expect(detail).toContain('action="/portal/admin/webhooks/wh_1/update"');
      expect(detail).toContain('action="/portal/admin/webhooks/wh_1/test"');
      expect(detail).toContain('action="/portal/admin/webhooks/wh_1/rotate-secret"');
      expect(detail).toContain('action="/portal/admin/webhooks/wh_1/delete"');
      expect(detail).toContain(
        'action="/portal/admin/webhook-deliveries/del_1/retry"',
      );
    });

    it("admin flash lands in a toast, not a top banner", () => {
      const html = renderAdminOrganisations({
        currentUserEmail: "admin@clear.dev",
        pendingCount: 0,
        organisations: [],
        flash: { kind: "success", message: "Created Acme." },
      });
      expect(html).toContain('class="portal-toast portal-toast--success"');
      expect(html).toContain("Created Acme.");
      expect(html).not.toMatch(/<main class="wrap">[\s\S]*portal-toast[\s\S]*<\/main>/);
      expect(html).toMatch(/<\/main>[\s\S]*class="portal-toast/);
    });
  });

  describe("portal shell nav persistence across surfaces", () => {
    it("keeps the same logo, collapse toggle, and sandbox target on docs and admin", () => {
      for (const html of [
        renderPortalShell({
          surface: "docs",
          account: { email: "a@b.co", role: "admin" },
        }),
        renderPortalShell({
          surface: "admin",
          account: { email: "a@b.co", role: "admin" },
          activeHref: "/portal/admin",
        }),
        renderPortalShell({ surface: "portal", account: null }),
      ]) {
        expect(html).toContain("/portal/icons/clearapi_logo.png");
        expect(html).toContain("toggleSidebar");
        expect(html).toContain('href="/graphql"');
        expect(html).toContain('target="_blank"');
      }
    });
  });
});
