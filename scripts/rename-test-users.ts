/**
 * One-off: rename every @clear.dev account to @clearinitiative.io in an EXISTING
 * database (clear.dev is not our domain), and create the new
 * emr.user@clearinitiative.io account. Covers the demo accounts (admin / analyst
 * / viewer) AND the service identities (pipeline / agent).
 *
 * Why this exists: the code that creates these users matches by email (seed.ts
 * and the create-*-user scripts are find-or-create), so changing those emails
 * only takes effect on a FRESH create — it will NOT touch the @clear.dev users
 * already living in the dev & prod databases (re-running would create duplicate
 * .io users alongside them). This script updates the existing rows in place, and
 * leaves each user's role + API keys intact (keys are keyed on the user id, not
 * the email, so renaming does not break the pipeline/agent credentials). Run it
 * once per environment.
 *
 * Idempotent + safe:
 *   - Login is by email → user row, and the credential `account` row keys on the
 *     user id (not the email), so updating `user.email` is sufficient for sign-in.
 *   - A rename is skipped if the source user is absent (already renamed) or if the
 *     target email is already taken (avoids a unique-constraint crash) — so
 *     re-running is a no-op.
 *   - DRY-RUN by default: prints the plan and changes nothing. Pass --apply to
 *     write. Point DATABASE_URL at the environment you mean to change.
 *
 * emr.user org / team membership (optional, environment-specific IDs — pass per DB):
 *   --org-id  <cuid>   add emr.user to this organisation (role: member)
 *   --team-id <cuid>   add emr.user to this team (role: emergency_response_manager)
 * Both are validated to exist first and applied idempotently; omit either to skip it.
 *
 * Usage:
 *   bun scripts/rename-test-users.ts            # dry run (no writes)
 *   bun scripts/rename-test-users.ts --apply    # perform the changes
 *   bun scripts/rename-test-users.ts --apply --org-id <cuid> --team-id <cuid>
 */
import "dotenv/config";

import { auth } from "../src/lib/auth.js";
import { prisma } from "../src/lib/prisma.js";

const APPLY = process.argv.includes("--apply");

function flagVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const ORG_ID = flagVal("org-id");
const TEAM_ID = flagVal("team-id");
const ORG_ROLE = "member";
const TEAM_ROLE = "emergency_response_manager"; // the whole point of this account

// Old → new for every renameable account. admin is driven by ADMIN_EMAIL and is
// already admin@clearinitiative.io in dev & prod; that pair is kept only to fix
// any local DB still seeded with the old default. pipeline/agent exist only where
// the create-*-user scripts were run with their old defaults. Each rename is
// skipped where the source is absent, so the full list is safe everywhere.
const RENAMES: Array<{ from: string; to: string }> = [
  { from: "admin@clear.dev", to: "admin@clearinitiative.io" },
  { from: "analyst@clear.dev", to: "analyst@clearinitiative.io" },
  { from: "viewer@clear.dev", to: "viewer@clearinitiative.io" },
  { from: "pipeline@clear.dev", to: "pipeline@clearinitiative.io" },
  { from: "agent@clear.dev", to: "agent@clearinitiative.io" },
];

// New account to create if missing. emergency_response_manager is a TEAM role,
// not a global one, so this user is a global "viewer"; its team membership (with
// the emergency_response_manager role) is assigned separately once a team exists.
const EMR = {
  email: "emr.user@clearinitiative.io",
  name: "Emergency Response Manager",
  // Distinct strong password (not the shared password123); matches prisma/seed.ts.
  password: "Emr#09bc64391b2c5cd30802a3f7372907a2",
  role: "viewer",
};

async function main() {
  console.log(APPLY ? "── APPLY: writing changes ──" : "── DRY RUN: no changes will be written (pass --apply) ──");

  for (const { from, to } of RENAMES) {
    const src = await prisma.user.findUnique({ where: { email: from } });
    if (!src) {
      console.log(`skip rename ${from} → ${to}: no user with ${from} (already renamed?)`);
      continue;
    }
    const clash = await prisma.user.findUnique({ where: { email: to } });
    if (clash) {
      console.log(`skip rename ${from} → ${to}: ${to} already exists (id ${clash.id})`);
      continue;
    }
    if (APPLY) {
      await prisma.user.update({ where: { id: src.id }, data: { email: to } });
      console.log(`renamed ${from} → ${to} (id ${src.id})`);
    } else {
      console.log(`would rename ${from} → ${to} (id ${src.id})`);
    }
  }

  // Create emr.user if absent (credential login, mirrors prisma/seed.ts).
  let emrId: string | undefined = (await prisma.user.findUnique({ where: { email: EMR.email } }))?.id;
  if (emrId) {
    console.log(`skip create ${EMR.email}: already exists (id ${emrId})`);
  } else if (!APPLY) {
    console.log(`would create ${EMR.email} (role ${EMR.role}, password ${EMR.password})`);
  } else {
    const authCtx = await auth.$context;
    const hash = await authCtx.password.hash(EMR.password);
    const user = await authCtx.internalAdapter.createUser({
      email: EMR.email,
      name: EMR.name,
      emailVerified: true,
    });
    await authCtx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, role: EMR.role },
    });
    emrId = user.id;
    console.log(`created ${EMR.email} (id ${user.id}, role ${EMR.role})`);
  }

  // Org membership (optional; --org-id per environment).
  if (ORG_ID) {
    const org = await prisma.organisations.findUnique({ where: { id: ORG_ID } });
    if (!org) {
      console.log(`skip org membership: no organisation with id ${ORG_ID} in this DB`);
    } else if (!emrId) {
      console.log(`would add ${EMR.email} to org ${ORG_ID} (role ${ORG_ROLE}) — needs emr.user (dry run)`);
    } else {
      const existing = await prisma.organisationUsers.findUnique({
        where: { userId_organisationId: { userId: emrId, organisationId: ORG_ID } },
      });
      if (existing) {
        console.log(`skip org membership: ${EMR.email} already in org ${ORG_ID} (role ${existing.role})`);
      } else if (!APPLY) {
        console.log(`would add ${EMR.email} to org ${ORG_ID} (role ${ORG_ROLE})`);
      } else {
        await prisma.organisationUsers.create({
          data: { userId: emrId, organisationId: ORG_ID, role: ORG_ROLE },
        });
        console.log(`added ${EMR.email} to org ${ORG_ID} (role ${ORG_ROLE})`);
      }
    }
  }

  // Team membership (optional; --team-id per environment) with the ERM role.
  if (TEAM_ID) {
    const team = await prisma.teams.findUnique({ where: { id: TEAM_ID } });
    if (!team) {
      console.log(`skip team membership: no team with id ${TEAM_ID} in this DB`);
    } else if (!emrId) {
      console.log(`would add ${EMR.email} to team ${TEAM_ID} (role ${TEAM_ROLE}) — needs emr.user (dry run)`);
    } else {
      const existing = await prisma.teamMembers.findUnique({
        where: { teamId_userId: { teamId: TEAM_ID, userId: emrId } },
      });
      if (existing) {
        console.log(`skip team membership: ${EMR.email} already in team ${TEAM_ID} (role ${existing.role})`);
      } else if (!APPLY) {
        console.log(`would add ${EMR.email} to team ${TEAM_ID} (role ${TEAM_ROLE})`);
      } else {
        await prisma.teamMembers.create({
          data: { teamId: TEAM_ID, userId: emrId, role: TEAM_ROLE },
        });
        console.log(`added ${EMR.email} to team ${TEAM_ID} (role ${TEAM_ROLE})`);
      }
    }
  }

  console.log(APPLY ? "── done ──" : "── dry run complete (re-run with --apply to write) ──");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("rename-test-users failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
