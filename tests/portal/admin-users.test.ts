import { describe, expect, it } from "vitest";
import { renderAdminUsers } from "../../src/portal/template.js";

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
          organisations: ["NRC"],
        },
      ],
    });

    expect(html).toContain("Users");
    expect(html).toContain("new@example.com");
    expect(html).toContain("ok@example.com");
    expect(html).toContain("NRC");
    expect(html).toContain("Approve");
    expect(html).toContain("btn-approve");
    expect(html).toMatch(/\.btn-approve\s*\{[^}]*border-radius:\s*6px/);
    expect(html).toContain('value="u-pending"');
    expect(html).not.toContain('value="u-viewer"');
    expect(html).toContain("tab=users");
    expect(html).toContain("1 waiting for approval");
  });

  it("still works from the old pending tab alias renderer", async () => {
    const { renderAdminPending } = await import("../../src/portal/template.js");
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
    expect(html).toContain("w@example.com");
    expect(html).toContain("Approve");
  });
});
