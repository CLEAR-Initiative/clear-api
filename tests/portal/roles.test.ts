import { describe, expect, it } from "vitest";
import {
  canonicalOrgRole,
  canonicalTeamRole,
  isGlobalRole,
} from "../../src/portal/roles.js";

describe("canonicalOrgRole", () => {
  it("maps legacy owner/admin onto org_admin", () => {
    expect(canonicalOrgRole("owner")).toBe("org_admin");
    expect(canonicalOrgRole("admin")).toBe("org_admin");
    expect(canonicalOrgRole("org_admin")).toBe("org_admin");
  });

  it("maps everything else to member", () => {
    expect(canonicalOrgRole("member")).toBe("member");
    expect(canonicalOrgRole("viewer")).toBe("member");
  });
});

describe("canonicalTeamRole", () => {
  it("maps legacy lead/analyst/viewer onto the current taxonomy", () => {
    expect(canonicalTeamRole("lead")).toBe("team_admin");
    expect(canonicalTeamRole("analyst")).toBe("analyst");
    expect(canonicalTeamRole("emergency_response_manager")).toBe(
      "emergency_response_manager",
    );
    // `field_coordinator` and `viewer` are removed team roles — merged into
    // `team_member`.
    expect(canonicalTeamRole("field_coordinator")).toBe("team_member");
    expect(canonicalTeamRole("viewer")).toBe("team_member");
  });
});

describe("isGlobalRole", () => {
  it("accepts member and admin only", () => {
    expect(isGlobalRole("member")).toBe(true);
    expect(isGlobalRole("admin")).toBe(true);
    // `analyst` and `viewer` are no longer global roles.
    expect(isGlobalRole("analyst")).toBe(false);
    expect(isGlobalRole("viewer")).toBe(false);
    expect(isGlobalRole("pending")).toBe(false);
    expect(isGlobalRole("org_admin")).toBe(false);
  });
});
