import { describe, expect, it } from "vitest";
import { renderAdminPending, renderAdminUsers } from "../../src/portal/template.js";

describe("renderAdminUsers", () => {
  it("lists pending and approved signups with approve only on pending", () => {
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
    expect(html).toMatch(/value="u-pending"/);
    expect(html).not.toMatch(/value="u-viewer"/);
    expect(html).toMatch(/org-stat-label">Name</);
    expect(html).toMatch(/org-stat-label">Email</);
    expect(html).toMatch(/org-stat-label">Organisation</);
    expect(html).toMatch(/org-stat-label">Role</);
    expect(html).toMatch(/org-stat-label">Signed up</);
    expect(html).toMatch(/1 waiting for approval/);
    expect(html).toMatch(/\.btn-approve\s*\{[^}]*border-radius:\s*6px/);
    expect(html).toMatch(
      /\.users-card-stats \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    );
  });

  it("still works from the old pending tab alias renderer", () => {
    const html = renderAdminPending({
      currentUserEmail: "admin@clear.dev",
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
