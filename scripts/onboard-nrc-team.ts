/**
 * One-shot onboarding for the NRC team:
 *
 *   For each email in the list, in order:
 *
 *     1. If the user is NOT on the platform yet
 *          → create a pending invitation tied to the configured org + team
 *            (roles: org=member, team=viewer) and send the invite email.
 *          → skip the rest — subscriptions/email-pref toggles only make
 *            sense for an existing user account.
 *
 *     2. If the user IS on the platform
 *          → ensure they're a member of the org (insert organisationUsers
 *            row when missing).
 *          → ensure they're a member of the team (insert teamMembers row
 *            with role=viewer when missing).
 *          → flip user.emailNotification = true if it isn't already.
 *          → if they have ZERO existing alert subscriptions, create a row
 *            per (alertType, level-0 location) combination — channel=email,
 *            frequency=immediately, minSeverity=1, active=true. The
 *            notifier already walks ancestor location ids when matching, so
 *            subscribing at country level catches every state/district
 *            beneath. Users with at least one existing subscription are
 *            left alone (per spec).
 *
 * Usage:
 *   bun run scripts/onboard-nrc-team.ts                       # apply
 *   bun run scripts/onboard-nrc-team.ts --dry-run             # preview
 *   bun run scripts/onboard-nrc-team.ts --invited-by <userId> # pin inviter
 *
 * The org / team / email list are hard-coded below — edit them in place
 * for re-runs against different cohorts.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";

import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/utils/env.js";
import { getEmailProvider } from "../src/services/messaging/registry.js";
import { organisationInvite } from "../src/services/messaging/templates.js";

// ─── Config ───────────────────────────────────────────────────────────────
const ORG_ID = "cmmw90rb20000ec9kgwc9thda";
const TEAM_ID = "cmnd0epfl00214pmsjbjn7lpe";
const ORG_ROLE = "member";
const TEAM_ROLE = "viewer";

const EMAILS = [
  "alamin.kharif@nrc.no",
  "amjad.elayyan@nrc.no",
  "dimitra.paschalidou@nrc.no",
  "fadwa.eltayeb@nrc.no",
  "garang.garangkuei@nrc.no",
  "hani.eltayib@nrc.no",
  "hiba.j.yaghmour@nrc.no",
  "kamel.alsharif@nrc.no",
  "lara.lteif@nrc.no",
  "mathilde.vu@nrc.no",
  "ahmed.albraifkani@nrc.no",
  "ahmed.maaji@nrc.no",
  "anjili.yakubu@nrc.no",
  "Giovanni.zanoletti@nrc.no",
  "grace.oonge@nrc.no",
  "mohammedzain.musa@nrc.no",
  "noah.taylor@nrc.no",
  "panagiotis.sikelis@nrc.no",
  "gerson.bergeth@nrc.no",
];

// ─── Flags ────────────────────────────────────────────────────────────────
interface Flags {
  dryRun: boolean;
  invitedById: string | null;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) return null;
    return argv[i + 1] ?? null;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    invitedById: get("--invited-by"),
  };
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// ─── Main ─────────────────────────────────────────────────────────────────
interface RunStats {
  invited: number;
  invitesSkipped: number;
  orgAdded: number;
  teamAdded: number;
  emailEnabled: number;
  subscribed: number;
  alreadySubscribed: number;
  errors: number;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const stats: RunStats = {
    invited: 0,
    invitesSkipped: 0,
    orgAdded: 0,
    teamAdded: 0,
    emailEnabled: 0,
    subscribed: 0,
    alreadySubscribed: 0,
    errors: 0,
  };

  // ── Validate org + team ──────────────────────────────────────────────
  const [org, team] = await Promise.all([
    prisma.organisations.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } }),
    prisma.teams.findUnique({ where: { id: TEAM_ID }, select: { id: true, name: true, organisationId: true } }),
  ]);
  if (!org) throw new Error(`Org ${ORG_ID} not found`);
  if (!team) throw new Error(`Team ${TEAM_ID} not found`);
  if (team.organisationId !== ORG_ID) {
    throw new Error(`Team ${TEAM_ID} belongs to org ${team.organisationId}, not ${ORG_ID}`);
  }

  // ── Resolve inviter ──────────────────────────────────────────────────
  // Need a real user id for invitations.invitedById. Prefer the explicit
  // flag; fall back to the first global admin so the script is runnable
  // without setup.
  let inviter: { id: string; name: string } | null = null;
  if (flags.invitedById) {
    inviter = await prisma.user.findUnique({
      where: { id: flags.invitedById },
      select: { id: true, name: true },
    });
    if (!inviter) throw new Error(`--invited-by user ${flags.invitedById} not found`);
  } else {
    inviter = await prisma.user.findFirst({
      where: { role: "admin" },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    if (!inviter) {
      throw new Error("No global admin found. Pass --invited-by <userId> with a valid user id.");
    }
  }
  console.log(`[ONBOARD] inviter=${inviter.name} (${inviter.id})  org=${org.name}  team=${team.name}  dryRun=${flags.dryRun}`);

  // ── Pre-fetch the subscription matrix data ───────────────────────────
  const [disasterTypes, level0Locations] = await Promise.all([
    prisma.disasterTypes.findMany({ select: { glideNumber: true } }),
    prisma.locations.findMany({ where: { level: 0 }, select: { id: true, name: true } }),
  ]);
  const alertTypes = [...new Set(disasterTypes.map((d) => d.glideNumber).filter(Boolean))];
  if (alertTypes.length === 0 || level0Locations.length === 0) {
    throw new Error(
      `Cannot subscribe: alertTypes=${alertTypes.length} level0Locations=${level0Locations.length}`,
    );
  }
  console.log(
    `[ONBOARD] subscription matrix: ${alertTypes.length} types × ${level0Locations.length} countries = ${alertTypes.length * level0Locations.length} rows per fresh user`,
  );

  // ── Process each email ───────────────────────────────────────────────
  for (const rawEmail of EMAILS) {
    const email = rawEmail.trim();
    if (!email) continue;

    try {
      // Email lookup is case-insensitive — addresses are mixed-case in the
      // input list but Better Auth stores them lower-cased.
      const existingUser = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, name: true, email: true, emailNotification: true },
      });

      if (!existingUser) {
        await handleNewUser(email, inviter, flags.dryRun, stats);
      } else {
        await handleExistingUser(existingUser, alertTypes, level0Locations, flags.dryRun, stats);
      }
    } catch (err) {
      stats.errors++;
      console.error(`[${email}] FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  console.log("\n[ONBOARD] Done:", stats);
}

// ─── Helpers ──────────────────────────────────────────────────────────────
async function handleNewUser(
  email: string,
  inviter: { id: string; name: string },
  dryRun: boolean,
  stats: RunStats,
): Promise<void> {
  // Skip if there's already a pending, unaccepted, unexpired invitation
  // for this (email, org). Resending should be opt-in, not implicit.
  const existingInvite = await prisma.invitations.findFirst({
    where: {
      email,
      organisationId: ORG_ID,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (existingInvite) {
    console.log(`[${email}] skip — pending invite ${existingInvite.id} already exists`);
    stats.invitesSkipped++;
    return;
  }

  if (dryRun) {
    console.log(`[${email}] would invite to org=${ORG_ID} team=${TEAM_ID}`);
    stats.invited++;
    return;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invitation = await prisma.invitations.create({
    data: {
      email,
      organisationId: ORG_ID,
      role: ORG_ROLE,
      token,
      expiresAt,
      invitedById: inviter.id,
      teams: {
        create: [{ teamId: TEAM_ID, teamRole: TEAM_ROLE }],
      },
    },
    select: { id: true },
  });

  // Send invite email — same template the inviteUser resolver uses, so the
  // landing page on the frontend is the existing /accept-invite flow.
  const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${token}`;
  const team = await prisma.teams.findUnique({ where: { id: TEAM_ID }, select: { name: true } });
  const org = await prisma.organisations.findUnique({ where: { id: ORG_ID }, select: { name: true } });
  const emailProvider = await getEmailProvider();
  const content = organisationInvite(
    inviter.name,
    org!.name,
    ORG_ROLE,
    inviteUrl,
    `${team!.name} (${TEAM_ROLE})`,
  );
  await emailProvider.send({
    to: email,
    subject: content.subject,
    textBody: content.textBody,
    htmlBody: content.htmlBody,
  });

  console.log(`[${email}] invited (id=${invitation.id})`);
  stats.invited++;
}

async function handleExistingUser(
  user: { id: string; name: string; email: string; emailNotification: boolean },
  alertTypes: string[],
  level0Locations: Array<{ id: string; name: string }>,
  dryRun: boolean,
  stats: RunStats,
): Promise<void> {
  // 1) Ensure org membership
  const orgMember = await prisma.organisationUsers.findUnique({
    where: { userId_organisationId: { userId: user.id, organisationId: ORG_ID } },
    select: { id: true },
  });
  if (!orgMember) {
    if (!dryRun) {
      await prisma.organisationUsers.create({
        data: { userId: user.id, organisationId: ORG_ID, role: ORG_ROLE },
      });
    }
    stats.orgAdded++;
    console.log(`[${user.email}] add to org`);
  }

  // 2) Ensure team membership
  const teamMember = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId: TEAM_ID, userId: user.id } },
    select: { id: true },
  });
  if (!teamMember) {
    if (!dryRun) {
      await prisma.teamMembers.create({
        data: { teamId: TEAM_ID, userId: user.id, role: TEAM_ROLE },
      });
    }
    stats.teamAdded++;
    console.log(`[${user.email}] add to team`);
  }

  // 3) Toggle email notifications
  if (!user.emailNotification) {
    if (!dryRun) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailNotification: true },
      });
    }
    stats.emailEnabled++;
    console.log(`[${user.email}] enable email notifications`);
  }

  // 4) Subscribe to all (type × country) — only if user has zero subs
  const existingSubCount = await prisma.userAlertSubscriptions.count({
    where: { userId: user.id },
  });
  if (existingSubCount > 0) {
    stats.alreadySubscribed++;
    console.log(`[${user.email}] skip subscriptions — already has ${existingSubCount}`);
    return;
  }

  const rows = alertTypes.flatMap((alertType) =>
    level0Locations.map((loc) => ({
      userId: user.id,
      locationId: loc.id,
      alertType,
      active: true,
      minSeverity: 1,
      channel: "email" as const,
      frequency: "immediately" as const,
    })),
  );

  if (dryRun) {
    console.log(`[${user.email}] would create ${rows.length} subscriptions`);
    stats.subscribed += rows.length;
    return;
  }

  // userAlertSubscriptions has no compound unique key on (userId, locationId,
  // alertType, channel), so duplicate prevention sits on us. The earlier
  // count check guarantees the user has none, but createMany still uses
  // skipDuplicates as a belt-and-braces safety net.
  const created = await prisma.userAlertSubscriptions.createMany({
    data: rows,
    skipDuplicates: true,
  });
  stats.subscribed += created.count;
  console.log(`[${user.email}] subscribed to ${created.count}/${rows.length} (type × location) combinations`);
}

main()
  .catch((err) => {
    console.error("[ONBOARD] Fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
