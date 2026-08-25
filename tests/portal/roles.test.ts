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
    expect(canonicalTeamRole("analyst")).toBe("field_coordinator");
    expect(canonicalTeamRole("viewer")).toBe("team_member");
  });
});

describe("isGlobalRole", () => {
  it("accepts viewer, analyst, and admin only", () => {
    expect(isGlobalRole("admin")).toBe(true);
    expect(isGlobalRole("pending")).toBe(false);
    expect(isGlobalRole("org_admin")).toBe(false);
  });
});
