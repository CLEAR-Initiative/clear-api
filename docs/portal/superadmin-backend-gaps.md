# SuperAdmin portal — known GraphQL backend gaps

The HTML SuperAdmin panel at `/portal/admin` implements organisation
management in the **portal layer** (`src/portal/admin-orgs.ts`) using
Prisma directly. It mirrors the organisation and invitation resolvers but
does not modify them. The following resolver/schema mismatches remain and
should be fixed in a dedicated backend follow-up.

## 1. `createOrganisation` does not add the creator as `org_admin`

**Schema doc** (`mutation.ts`):

> Create a new organisation. The creator becomes the first org_admin.

**Resolver** (`organisation.resolver.ts`): creates the org and a default
team only — no `organisationUsers` row.

**Portal workaround:** when the first member is invited or added via the
SuperAdmin UI, the form defaults org role to `org_admin`
(`defaultOrgRoleForNewMember`).

**Recommended fix:** after creating the org + default team, insert
`organisationUsers` for the authenticated caller with role `org_admin`,
or accept an optional `initialAdminUserId` on create.

## 2. `addOrgMember` defaults to `member`, not first-user `org_admin`

**Resolver:** `role: args.role ?? "member"` regardless of whether the org
has zero members.

**Portal workaround:** same as above — SuperAdmin forms pre-select
`org_admin` when `memberCount === 0`.

**Recommended fix:** when `organisationUsers` count for the org is 0 and
`role` is omitted, default to `org_admin`.

## 3. No `updateUser` GraphQL mutation

SuperAdmin can edit a member's **display name** and **org role** in the
portal (Prisma). There is no GraphQL mutation to change global user
fields (name, global role) for platform admins outside the portal.

**Out of scope for portal:** global role changes remain on the Pending
Users tab (`approveUser` flips `pending` → `viewer`) or require a future
`updateUser` mutation.

## 4. Portal vs GraphQL duplication

Org CRUD and invites are implemented twice (resolvers + portal). Once
backend behaviour matches the schema docs, consider extracting shared
service functions used by both GraphQL and the portal to avoid drift.

## 5. `createTeam` adds the caller as `team_admin`; portal creates empty teams

**GraphQL `createTeam`:** auto-adds the authenticated creator as
`team_admin` on the new team.

**Portal `portalCreateTeam`:** creates a team with **no members** so the
SuperAdmin can populate it via invite/add flows. Intentional portal
behaviour for operator-driven onboarding.
