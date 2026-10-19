-- Role-model refactor: global roles become `member`/`admin`; `analyst` moves to
-- a TEAM role; team `field_coordinator` is merged into `team_member`.
--
-- ORDER MATTERS: the team-analyst upgrade reads WHERE role='analyst' on the user
-- table, so it must run BEFORE the global analyst→member flip.

-- 1. Existing GLOBAL analysts: give them the team `analyst` role on the team(s)
--    they already belong to (decision: → member + team analyst where a team
--    exists; skip if none). Only upgrade non-elevated memberships so we never
--    demote a team_admin / ERM.
UPDATE "team_members"
SET "role" = 'analyst'
WHERE "user_id" IN (SELECT "id" FROM "user" WHERE "role" = 'analyst')
  AND "role" IN ('team_member', 'field_coordinator');

-- 2. Merge the removed `field_coordinator` team role into `team_member`
--    everywhere it is stored.
UPDATE "team_members" SET "role" = 'team_member' WHERE "role" = 'field_coordinator';
UPDATE "invitations" SET "team_role" = 'team_member' WHERE "team_role" = 'field_coordinator';
UPDATE "invitation_teams" SET "team_role" = 'team_member' WHERE "team_role" = 'field_coordinator';

-- 3. Defensive normalisation of any lingering legacy team values (no prior
--    backfill migration existed): lead → team_admin, viewer → team_member.
UPDATE "team_members" SET "role" = 'team_admin' WHERE "role" = 'lead';
UPDATE "team_members" SET "role" = 'team_member' WHERE "role" = 'viewer';
UPDATE "invitations" SET "team_role" = 'team_admin' WHERE "team_role" = 'lead';
UPDATE "invitations" SET "team_role" = 'team_member' WHERE "team_role" = 'viewer';
UPDATE "invitation_teams" SET "team_role" = 'team_admin' WHERE "team_role" = 'lead';
UPDATE "invitation_teams" SET "team_role" = 'team_member' WHERE "team_role" = 'viewer';

-- 4. Global roles: analyst → member (their team analyst rows were set in step 1),
--    viewer → member. `admin`, `pending`, and the system roles (worker, pipeline,
--    agent) are untouched.
UPDATE "user" SET "role" = 'member' WHERE "role" = 'analyst';
UPDATE "user" SET "role" = 'member' WHERE "role" = 'viewer';

-- 5. Ground-source reviewer roles are GLOBAL roles; drop the now-invalid
--    `analyst` and rename `viewer` → `member` on existing rows.
UPDATE "ground_sources" SET "reviewer_roles" = array_remove("reviewer_roles", 'analyst');
UPDATE "ground_sources"
SET "reviewer_roles" = array_replace("reviewer_roles", 'viewer', 'member')
WHERE 'viewer' = ANY("reviewer_roles");

-- 6. Column default changes to match the Prisma schema.
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'member';
ALTER TABLE "ground_sources" ALTER COLUMN "reviewer_roles" SET DEFAULT ARRAY['admin']::TEXT[];
