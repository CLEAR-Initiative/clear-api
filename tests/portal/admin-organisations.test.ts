import { describe, expect, it } from "vitest";
import {
  defaultOrgRoleForNewMember,
  slugifyName,
} from "../../src/portal/admin-orgs.js";
import {
  renderAdminOrganisations,
  renderAdminOrgDetail,
} from "../../src/portal/template.js";

describe("defaultOrgRoleForNewMember", () => {
  it("returns org_admin for the first member", () => {
    expect(defaultOrgRoleForNewMember(0)).toBe("org_admin");
  });

  it("returns member when the org already has members", () => {
    expect(defaultOrgRoleForNewMember(1)).toBe("member");
  });
});

describe("slugifyName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyName("Acme Response")).toBe("acme-response");
  });
});

describe("renderAdminOrganisations", () => {
  it("lists organisations and shows create form", () => {
    const html = renderAdminOrganisations({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 2,
      organisations: [
        {
          id: "org_1",
          name: "Acme",
          slug: "acme",
          isActive: true,
          memberCount: 3,
          teamCount: 1,
          createdAt: new Date("2026-01-15"),
        },
      ],
    });

    expect(html).toContain("Organisations");
    expect(html).toContain("Acme");
    expect(html).toContain('tab=organisations&amp;org=org_1');
    expect(html).toContain('action="/portal/admin/orgs/create"');
    expect(html).toContain("Organisation name");
    expect(html).toContain('class="field-affix-prefix"');
    expect(html).toContain("Users");
    expect(html).toContain(">2<");
    expect(html).not.toContain("backend gaps");
    expect(html).toContain('class="org-card"');
    expect(html).toContain('class="org-card-stats"');
    expect(html).toContain("org-stat-value");
    expect(html).not.toContain("<table");
    expect(html).toContain('title="Open Acme"');
    expect(html).toContain("text-overflow: ellipsis");
    expect(html).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.admin-tabs \{[\s\S]*?display:\s*none/,
    );
    expect(html).toContain("nav-sub--admin");
    expect(html).toContain("/portal/admin?tab=organisations");
  });

  it("renders flash as a bottom-right toast instead of a page banner", () => {
    const html = renderAdminOrganisations({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      organisations: [],
      flash: { kind: "success", message: 'Created "Acme".' },
    });

    expect(html).toContain('class="portal-toast portal-toast--success"');
    expect(html).toContain("Created &quot;Acme&quot;.");
    expect(html).not.toContain("margin: 0 0 1.5rem");
    expect(html).toContain("org-card--empty");
    expect(html).not.toContain("<table");
  });
});

describe("renderAdminOrgDetail", () => {
  it("renders team management and per-team invite forms", () => {
    const html = renderAdminOrgDetail({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      defaultInviteOrgRole: "org_admin",
      org: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        isActive: true,
        createdAt: new Date("2026-01-15"),
        importableTeams: [
          { id: "team_src", label: "Other Org / Ops", memberCount: 4 },
        ],
        teams: [
          {
            id: "team_1",
            name: "Acme",
            slug: "acme",
            description: "Default team",
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

    expect(html).toContain("Create team");
    expect(html).toContain("Import team");
    expect(html).toContain('action="/portal/admin/orgs/teams/import"');
    expect(html).toContain('action="/portal/admin/orgs/teams/members/add"');
    expect(html).toContain("lead@acme.dev");
    expect(html).toContain("Organisation members");
    expect(html).toContain('class="field"');
    expect(html).toContain('class="field-select"');
    expect(html).toMatch(/<input class="field" name="name"/);
    expect(html).toMatch(/<select class="field-select" name="role"/);
    expect(html).toMatch(/<select class="field-select" name="teamRole"/);
    expect(html).toMatch(/<select class="field-select" id="import-team"/);
    expect(html).not.toContain('size="18"');
    expect(html).toContain("--control-height: 2.5rem");
    expect(html).toContain(".form-grid > .form-actions .btn-primary");
    expect(html).toContain('<label for="edit-name">Organisation name</label>');
    expect(html).toContain("org-edit-grid");
    expect(html).toContain('class="field-affix-prefix"');
    expect(html).toContain(".members-card > .members-head");
    expect(html).toContain('content: "Org role"');
    expect(html).toContain("text-overflow: ellipsis");
    expect(html).toContain("admin-page-heading--end");
    expect(html).toContain("Save changes");
    expect(html).toContain("Send invite");
    expect(html).toContain("Add to team");
    expect(html).toContain("Create empty team");
    expect(html).toContain(">Import team</button>");
    expect(html).not.toContain("Import team &amp; members");

    const backIdx = html.indexOf("← All organisations");
    const h1Idx = html.indexOf("<h1>Acme</h1>");
    const membersIdx = html.indexOf("<h2>Organisation members</h2>");
    const teamsIdx = html.indexOf("<h2>Teams</h2>");
    const createIdx = html.indexOf("<h2>Create team</h2>");
    const importIdx = html.indexOf("<h2>Import team</h2>");
    expect(backIdx).toBeGreaterThan(-1);
    expect(backIdx).toBeLessThan(h1Idx);
    expect(html).toContain("1 member · 1 team");
    expect(html).not.toContain("Organisation ·");
    expect(membersIdx).toBeGreaterThan(h1Idx);
    expect(membersIdx).toBeLessThan(teamsIdx);
    expect(teamsIdx).toBeLessThan(createIdx);
    expect(createIdx).toBeLessThan(importIdx);

    expect(html).toContain('id="org-delete-tab"');
    expect(html).toContain('action="/portal/admin/orgs/delete"');
    expect(html).toContain('aria-label="Delete organisation"');
    expect(html).not.toContain('id="delete-org-modal"');
    expect(html).not.toContain("openDeleteOrgModal");
    expect(html).toContain("Delete team");
    expect(html).toContain('data-arm-label="Delete team"');
    expect(html).toContain('data-cancel-label="Cancel"');
    expect(html).toContain("swipe-delete");
    expect(html).toContain("swipe-delete__tab");
    expect(html).toContain("js-swipe-delete-arm");
    expect(html).toContain("bindSwipeDelete");
    expect(html).toContain("--swipe-delete-gap: 10px");
    expect(html).toContain("opacity: 0");
    expect(html).toContain(".swipe-delete.is-armed .swipe-delete__tab");
    expect(html).toContain("Confirm delete team");
    expect(html).toContain("Confirm delete organisation");
    expect(html).toContain("Confirm remove");
    expect(html).toContain("members-card");
    expect(html).toContain("team-members");
    expect(html).toContain("team-member-delete-tab-");
    expect(html).not.toContain("confirm('Delete this team");
    expect(html).not.toContain("confirm('Remove this member");
    expect(html).not.toContain("confirm('Remove this user from the team");
    expect(html).toContain("team-form-email-wide");
    expect(html).toContain("team-form-span-fields");
    expect(html).toContain(".team-form-grid .team-form-span-fields");
    expect(html).toContain("js-role-form");
    expect(html).toContain("btn-row-action");
    expect(html).toContain("row-save-check");
    expect(html).toContain("table-row-end");
    expect(html).toContain(".members-card .table-row-end");
    expect(html).toContain(".team-members .table-row-end");
    expect(html).toContain(".members-card .swipe-delete--row .swipe-delete__front");
    expect(html).toContain("padding: 0.85rem 1.25rem");
    expect(html).toContain("bindRoleForms");
    expect(html).toContain("js-dirty-form");
    expect(html).toContain("bindDirtyOrgForm");
    expect(html).toContain(".btn-primary:disabled");
    expect(html).toContain("Accept: 'application/json'");
    expect(html).toContain("10.5rem");
    expect(html).toMatch(
      /action="\/portal\/admin\/orgs\/teams\/create"[\s\S]*class="team-form-grid"/,
    );
    expect(html).toMatch(
      /action="\/portal\/admin\/orgs\/teams\/import"[\s\S]*class="team-form-grid"/,
    );
    expect(html).toContain('aria-label="Remove from team"');
    expect(html).not.toContain("confirm('Delete this organisation");
    expect(html).not.toContain('class="btn btn-danger btn-sm">Delete organisation');
  });

  it("sole-team member removal shows org-removal warning", () => {
    const html = renderAdminOrgDetail({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      defaultInviteOrgRole: "member",
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
            name: "Default Team",
            slug: "default",
            description: null,
            members: [
              {
                userId: "user_sole",
                email: "sole@example.com",
                name: "Sole Member",
                teamRole: "team_member",
              },
            ],
          },
        ],
        members: [
          {
            userId: "user_sole",
            email: "sole@example.com",
            name: "Sole Member",
            globalRole: null,
            orgRole: "member",
            joinedAt: new Date("2026-01-16"),
          },
        ],
      },
    });

    expect(html).toContain('action="/portal/admin/orgs/members/remove"');
    expect(html).toContain("User will be removed from the organisation if removed from this team. Do you want to proceed?");
    expect(html).not.toContain('action="/portal/admin/orgs/teams/members/remove"');
  });

  it("multi-team member removal shows team-scoped warning", () => {
    const html = renderAdminOrgDetail({
      currentUserEmail: "admin@clear.dev",
      pendingCount: 0,
      defaultInviteOrgRole: "member",
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
            name: "Team Alpha",
            slug: "alpha",
            description: null,
            members: [
              {
                userId: "user_multi",
                email: "multi@example.com",
                name: "Multi Member",
                teamRole: "team_member",
              },
            ],
          },
          {
            id: "team_2",
            name: "Team Beta",
            slug: "beta",
            description: null,
            members: [
              {
                userId: "user_multi",
                email: "multi@example.com",
                name: "Multi Member",
                teamRole: "team_admin",
              },
            ],
          },
        ],
        members: [
          {
            userId: "user_multi",
            email: "multi@example.com",
            name: "Multi Member",
            globalRole: null,
            orgRole: "member",
            joinedAt: new Date("2026-01-16"),
          },
        ],
      },
    });

    expect(html).toContain('action="/portal/admin/orgs/teams/members/remove"');
    expect(html).toContain("Remove this user from the team?");
    expect(html).not.toContain("User will be removed from the organisation if removed from this team");
  });
});
