/**
 * Role taxonomies used by the admin portal. GraphQL resolvers reject
 * legacy strings (`owner`, `lead`, …); the HTML dropdowns still have to
 * *display* those rows and write the canonical value back.
 */

export const ORG_ROLES = ["org_admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const TEAM_ROLES = [
  "team_admin",
  "field_coordinator",
  "team_member",
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const GLOBAL_ROLES = ["viewer", "analyst", "admin"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export function canonicalOrgRole(role: string | null | undefined): OrgRole {
  const r = (role ?? "").toLowerCase();
  if (r === "org_admin" || r === "owner" || r === "admin") return "org_admin";
  return "member";
}

export function canonicalTeamRole(role: string | null | undefined): TeamRole {
  const r = (role ?? "").toLowerCase();
  if (r === "team_admin" || r === "lead") return "team_admin";
  if (r === "field_coordinator" || r === "analyst") return "field_coordinator";
  return "team_member";
}

export function isOrgRole(role: string): role is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(role);
}

export function isTeamRole(role: string): role is TeamRole {
  return (TEAM_ROLES as readonly string[]).includes(role);
}

export function isGlobalRole(role: string): role is GlobalRole {
  return (GLOBAL_ROLES as readonly string[]).includes(role);
}
