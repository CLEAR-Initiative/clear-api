import { describe, expect, it } from "vitest";
import { renderAdminPending, renderAdminUsers } from "../../src/portal/template.js";

describe("renderAdminUsers", () => {
  it("lists pending and approved signups with approve only on pending", () => {
    const html = renderAdminUsers({
      currentUserEmail: "admin@clearinitiative.io",
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
        {
          id: "u-viewer",
          name: "Approved",
          email: "ok@example.com",
          role: "viewer",
          createdAt: new Date("2026-08-01"),
          organisations: [{ id: "org_nrc", name: "NRC" }],
        },
      ],
    });

    expect(html).toMatch(/users-card-list/);
    expect(html).toMatch(/<article class="users-card">/);
    expect(html).toMatch(/users-stat--row/);
    expect(html).toMatch(/new@example\.com/);
    expect(html).toMatch(/ok@example\.com/);
    expect(html).toMatch(/>NRC</);
    expect(html).toMatch(
      /href="\/portal\/admin\?tab=organisations&amp;org=org_nrc"/,
    );
    expect(html).toMatch(/users-org-link/);
    expect(html).toMatch(/btn-approve/);
    expect(html).toMatch(
      /<form method="POST" action="\/portal\/admin\/approve">\s*<input type="hidden" name="userId" value="u-pending"/,
    );
    expect(html).not.toMatch(
      /<form method="POST" action="\/portal\/admin\/approve">\s*<input type="hidden" name="userId" value="u-viewer"/,
    );
    expect(html).toMatch(/org-stat-label">Name</);
    expect(html).toMatch(/org-stat-label">Email</);
    expect(html).toMatch(/org-stat-label">Organisation</);
    expect(html).toMatch(/org-stat-label">Role</);
    expect(html).toMatch(/org-stat-label">Signed up</);
    expect(html).toContain("/portal/admin/users/role");
    expect(html).toMatch(/<select class="field-select" name="role"/);
    expect(html).toContain("js-role-form");
    expect(html).toMatch(/value="u-viewer"/);
    expect(html).toMatch(/1 waiting for approval/);
    expect(html).toMatch(/\.btn-approve\s*\{[^}]*border-radius:\s*6px/);
    expect(html).toMatch(
      /\.users-card-stats \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    );
  });

  it("still works from the old pending tab alias renderer", () => {
    const html = renderAdminPending({
      currentUserEmail: "admin@clearinitiative.io",
      pendingCount: 1,
      pendingUsers: [
        {
          id: "u1",
          name: "Waiter",
          email: "w@example.com",
          createdAt: new Date("2026-08-18"),
        },
      ],
    });
    expect(html).toMatch(/w@example\.com/);
    expect(html).toMatch(/Approve/);
  });
});

describe("renderAdminUsers — Welcome page profile", () => {
  const base = {
    currentUserEmail: "admin@clearinitiative.io",
    pendingCount: 1,
  };
  const pending = {
    id: "u-pending",
    name: "New Dev",
    email: "new@example.com",
    role: "pending",
    createdAt: new Date("2026-10-27"),
    organisations: [],
  };

  it("shows affiliation, links and contribution interest on pending users", () => {
    const html = renderAdminUsers({
      ...base,
      users: [
        {
          ...pending,
          profile: {
            personalWebsite: "https://ada.example.org/",
            organisation: "NRC",
            organisationWebsite: "https://www.nrc.no/",
            linkedinUrl: null,
            githubUrl: "https://github.com/ada",
            contributionInterest: "Data pipeline / LLMs",
          },
        },
      ],
    });
    expect(html).toContain("Affiliation");
    expect(html).toMatch(/<a class="users-profile-link" href="https:\/\/www\.nrc\.no\/" target="_blank" rel="noopener noreferrer"[^>]*>NRC<\/a>/);
    expect(html).toMatch(/href="https:\/\/github\.com\/ada"[^>]*rel="noopener noreferrer"[^>]*>GitHub</);
    expect(html).toContain("Would like to contribute");
    expect(html).toContain("Data pipeline / LLMs");
  });

  it("escapes every user-supplied value and refuses non-http links", () => {
    const xss = `"><script>alert(1)</script>`;
    const html = renderAdminUsers({
      ...base,
      users: [
        {
          ...pending,
          profile: {
            personalWebsite: "javascript:alert(1)",
            organisation: xss,
            organisationWebsite: `https://x.test/"onmouseover="alert(1)`,
            linkedinUrl: null,
            githubUrl: null,
            contributionInterest: xss,
          },
        },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("says when a pending user hasn't filled it in, and hides it for approved users", () => {
    const html = renderAdminUsers({
      ...base,
      users: [
        { ...pending, profile: null },
        {
          ...pending,
          id: "u-member",
          email: "member@example.com",
          role: "member",
          profile: {
            personalWebsite: null,
            organisation: "Member Org",
            organisationWebsite: null,
            linkedinUrl: null,
            githubUrl: null,
            contributionInterest: null,
          },
        },
      ],
    });
    expect(html).toContain("Not filled in yet");
    expect(html).not.toContain("Member Org");
  });
});
