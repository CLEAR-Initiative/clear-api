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
    expect(html).toContain("Pending Users");
    expect(html).toContain(">2<");
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
