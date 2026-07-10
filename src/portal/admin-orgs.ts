/**
 * SuperAdmin organisation management for the HTML portal.
 *
 * Uses Prisma directly (same pattern as admin metrics + approve-user) so the
 * portal does not depend on GraphQL. Behaviour mirrors the organisation and
 * invitation resolvers; known divergences are documented in
 * docs/portal/superadmin-backend-gaps.md.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { ensureDefaultTeam } from "../services/ensure-default-team.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import {
  organisationInvite,
  teamInviteNotification,
} from "../services/messaging/templates.js";
import { env } from "../utils/env.js";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "org"
  );
}

export function assertOrgSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error("Slug must be lowercase letters, numbers, and hyphens only.");
  }
}

/** Portal convention until createOrganisation adds the first org_admin in GraphQL. */
export function defaultOrgRoleForNewMember(memberCount: number): "org_admin" | "member" {
  return memberCount === 0 ? "org_admin" : "member";
}

export interface AdminOrgListItem {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  memberCount: number;
  teamCount: number;
}

export interface AdminOrgMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  globalRole: string | null;
  orgRole: string;
  joinedAt: Date;
}

export interface AdminOrgTeamMember {
  userId: string;
  email: string;
  name: string;
  teamRole: string;
}

export interface AdminOrgTeam {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  members: AdminOrgTeamMember[];
}

export interface AdminImportableTeam {
  id: string;
  label: string;
  memberCount: number;
}

export interface AdminOrgDetail {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  teams: AdminOrgTeam[];
  members: AdminOrgMember[];
  importableTeams: AdminImportableTeam[];
}

export async function listAdminOrganisations(): Promise<AdminOrgListItem[]> {
  const rows = await prisma.organisations.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { users: true, teams: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    isActive: o.isActive,
    createdAt: o.createdAt,
    memberCount: o._count.users,
    teamCount: o._count.teams,
  }));
}

export async function getAdminOrganisation(orgId: string): Promise<AdminOrgDetail | null> {
  const [org, importable] = await Promise.all([
    prisma.organisations.findUnique({
      where: { id: orgId },
      include: {
        teams: {
          orderBy: { createdAt: "asc" },
          include: {
            members: {
              orderBy: { createdAt: "asc" },
              include: {
                user: { select: { id: true, email: true, name: true } },
              },
            },
          },
        },
        users: {
          orderBy: { createdAt: "asc" },
          include: {
            user: { select: { id: true, email: true, name: true, role: true } },
          },
        },
      },
    }),
    listImportableTeams(orgId),
  ]);
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    isActive: org.isActive,
    createdAt: org.createdAt,
    teams: org.teams.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      members: t.members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        teamRole: m.role,
      })),
    })),
    members: org.users.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      globalRole: m.user.role,
      orgRole: m.role,
      joinedAt: m.createdAt,
    })),
    importableTeams: importable,
  };
}

export async function listImportableTeams(excludeOrgId: string): Promise<AdminImportableTeam[]> {
  const teams = await prisma.teams.findMany({
    where: { organisationId: { not: excludeOrgId } },
    include: {
      organisation: { select: { name: true } },
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });
  return teams.map((t) => ({
    id: t.id,
    label: `${t.organisation.name} / ${t.name}`,
    memberCount: t._count.members,
  }));
}

export async function portalCreateOrganisation(name: string, slug: string) {
  const trimmedName = name.trim();
  const trimmedSlug = slug.trim().toLowerCase();
  if (!trimmedName) throw new Error("Organisation name is required.");
  assertOrgSlug(trimmedSlug);

  const existing = await prisma.organisations.findUnique({ where: { slug: trimmedSlug } });
  if (existing) throw new Error(`Slug "${trimmedSlug}" is already taken.`);

  return prisma.$transaction(async (tx) => {
    const org = await tx.organisations.create({
      data: { name: trimmedName, slug: trimmedSlug },
    });
    await tx.teams.create({
      data: {
        organisationId: org.id,
        name: trimmedName,
        slug: trimmedSlug,
        description: "Default team — created automatically with the organisation.",
      },
    });
    return org;
  });
}

export async function portalUpdateOrganisation(
  orgId: string,
  input: { name?: string; slug?: string },
) {
  const data: { name?: string; slug?: string } = {};
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new Error("Organisation name cannot be empty.");
    data.name = trimmed;
  }
  if (input.slug !== undefined) {
    const trimmed = input.slug.trim().toLowerCase();
    assertOrgSlug(trimmed);
    const clash = await prisma.organisations.findFirst({
      where: { slug: trimmed, NOT: { id: orgId } },
    });
    if (clash) throw new Error(`Slug "${trimmed}" is already taken.`);
    data.slug = trimmed;
  }
  if (Object.keys(data).length === 0) throw new Error("Nothing to update.");
  return prisma.organisations.update({ where: { id: orgId }, data });
}

export async function portalDeleteOrganisation(orgId: string) {
  const org = await prisma.organisations.findUnique({ where: { id: orgId } });
  if (!org) throw new Error("Organisation not found.");
  await prisma.organisations.delete({ where: { id: orgId } });
  return org.name;
}

export async function portalAddOrgMember(
  orgId: string,
  emailOrUserId: string,
  role?: string,
) {
  const org = await prisma.organisations.findUnique({
    where: { id: orgId },
    include: { _count: { select: { users: true } } },
  });
  if (!org) throw new Error("Organisation not found.");

  let targetUserId = emailOrUserId.trim();
  if (targetUserId.includes("@")) {
    const found = await prisma.user.findFirst({ where: { email: targetUserId } });
    if (!found) throw new Error("No user found with that email address.");
    targetUserId = found.id;
  }

  const existing = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: targetUserId, organisationId: orgId },
    },
  });
  if (existing) throw new Error("User is already a member of this organisation.");

  const orgRole =
    role && ["org_admin", "member"].includes(role)
      ? role
      : defaultOrgRoleForNewMember(org._count.users);

  return prisma.$transaction(async (tx) => {
    const membership = await tx.organisationUsers.create({
      data: { userId: targetUserId, organisationId: orgId, role: orgRole },
    });

    const teams = await tx.teams.findMany({
      where: { organisationId: orgId },
      select: { id: true },
      take: 2,
    });
    if (teams.length === 1) {
      await tx.teamMembers.upsert({
        where: { teamId_userId: { teamId: teams[0]!.id, userId: targetUserId } },
        create: { teamId: teams[0]!.id, userId: targetUserId, role: "team_member" },
        update: {},
      });
    }

    return { membership, defaultTeamId: teams.length === 1 ? teams[0]!.id : null };
  }).then(async ({ membership, defaultTeamId }) => {
    if (defaultTeamId) {
      await ensureDefaultTeam(prisma, targetUserId, defaultTeamId);
    }
    return membership;
  });
}

export async function portalRemoveOrgMember(orgId: string, userId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.organisationUsers.delete({
        where: { userId_organisationId: { userId, organisationId: orgId } },
      });
      await tx.teamMembers.deleteMany({
        where: { userId, team: { organisationId: orgId } },
      });
      return true;
    });
  } catch {
    throw new Error("Member not found in this organisation.");
  }
}

export async function portalUpdateOrgMemberRole(
  orgId: string,
  userId: string,
  role: string,
) {
  if (!["org_admin", "member"].includes(role)) {
    throw new Error(`Invalid org role "${role}". Must be org_admin or member.`);
  }
  try {
    return await prisma.organisationUsers.update({
      where: { userId_organisationId: { userId, organisationId: orgId } },
      data: { role },
    });
  } catch {
    throw new Error("Member not found in this organisation.");
  }
}

export async function portalUpdateMemberName(userId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name cannot be empty.");
  return prisma.user.update({ where: { id: userId }, data: { name: trimmed } });
}

export async function portalInviteToOrganisation(opts: {
  orgId: string;
  inviterId: string;
  inviterName: string;
  email: string;
  orgRole?: string;
  teamId: string;
  teamRole?: string;
}) {
  const email = opts.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email address is required.");

  const org = await prisma.organisations.findUnique({
    where: { id: opts.orgId },
    include: { _count: { select: { users: true } } },
  });
  if (!org) throw new Error("Organisation not found.");

  const team = await prisma.teams.findFirst({
    where: { id: opts.teamId, organisationId: opts.orgId },
  });
  if (!team) throw new Error("Team not found in this organisation.");

  const orgRole =
    opts.orgRole && ["org_admin", "member"].includes(opts.orgRole)
      ? opts.orgRole
      : defaultOrgRoleForNewMember(org._count.users);
  const teamRole = opts.teamRole ?? "team_member";

  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    const existingMembership = await prisma.organisationUsers.findUnique({
      where: {
        userId_organisationId: { userId: existingUser.id, organisationId: opts.orgId },
      },
    });

    if (existingMembership) {
      const alreadyIn = await prisma.teamMembers.findUnique({
        where: { teamId_userId: { teamId: opts.teamId, userId: existingUser.id } },
      });
      if (alreadyIn) {
        throw new Error("User is already a member of this team.");
      }
      await prisma.teamMembers.create({
        data: { teamId: opts.teamId, userId: existingUser.id, role: teamRole },
      });
      await ensureDefaultTeam(prisma, existingUser.id, opts.teamId);
    } else {
      await portalAddOrgMember(opts.orgId, existingUser.id, orgRole);
      const inTeam = await prisma.teamMembers.findUnique({
        where: { teamId_userId: { teamId: opts.teamId, userId: existingUser.id } },
      });
      if (!inTeam) {
        await prisma.teamMembers.create({
          data: { teamId: opts.teamId, userId: existingUser.id, role: teamRole },
        });
        await ensureDefaultTeam(prisma, existingUser.id, opts.teamId);
      }
    }

    try {
      const emailProvider = await getEmailProvider();
      const content = teamInviteNotification(
        opts.inviterName,
        org.name,
        `${team.name} (${teamRole})`,
        teamRole,
        `${env.FRONTEND_URL}/dashboard`,
      );
      await emailProvider.send({
        to: email,
        subject: content.subject,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      });
    } catch (err) {
      console.error("[portalInviteToOrganisation] notification failed:", err);
    }

    return { kind: "added" as const, email };
  }

  const existingInvite = await prisma.invitations.findFirst({
    where: {
      email,
      organisationId: opts.orgId,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (existingInvite) {
    throw new Error(
      "A pending invitation already exists for this email in this organisation.",
    );
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.invitations.create({
    data: {
      email,
      organisationId: opts.orgId,
      role: orgRole,
      token,
      expiresAt,
      invitedById: opts.inviterId,
      teams: {
        create: [{ teamId: opts.teamId, teamRole }],
      },
    },
  });

  const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${token}`;
  const emailProvider = await getEmailProvider();
  const content = organisationInvite(
    opts.inviterName,
    org.name,
    orgRole,
    inviteUrl,
    `${team.name} (${teamRole})`,
  );
  await emailProvider.send({
    to: email,
    subject: content.subject,
    textBody: content.textBody,
    htmlBody: content.htmlBody,
  });

  return { kind: "invited" as const, email };
}

async function uniqueTeamSlugInOrg(orgId: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let n = 2;
  while (
    await prisma.teams.findUnique({
      where: { organisationId_slug: { organisationId: orgId, slug } },
    })
  ) {
    slug = `${baseSlug}-${n}`;
    n++;
  }
  return slug;
}

const TEAM_ROLES = ["team_admin", "field_coordinator", "team_member"] as const;

function assertTeamRole(role: string): string {
  if (!TEAM_ROLES.includes(role as (typeof TEAM_ROLES)[number])) {
    throw new Error(`Invalid team role "${role}".`);
  }
  return role;
}

/** Create an empty team in the organisation (SuperAdmin — no auto-added members). */
export async function portalCreateTeam(
  orgId: string,
  name: string,
  slug: string,
  description?: string,
) {
  const trimmedName = name.trim();
  const trimmedSlug = slug.trim().toLowerCase();
  if (!trimmedName) throw new Error("Team name is required.");
  assertOrgSlug(trimmedSlug);

  const org = await prisma.organisations.findUnique({ where: { id: orgId } });
  if (!org) throw new Error("Organisation not found.");

  const clash = await prisma.teams.findUnique({
    where: { organisationId_slug: { organisationId: orgId, slug: trimmedSlug } },
  });
  if (clash) throw new Error(`Slug "${trimmedSlug}" is already used in this organisation.`);

  return prisma.teams.create({
    data: {
      organisationId: orgId,
      name: trimmedName,
      slug: trimmedSlug,
      description: description?.trim() || null,
    },
  });
}

/**
 * Copy a team from another organisation into this one, importing all of its
 * members into the org (when needed) and the new team.
 */
export async function portalImportTeam(targetOrgId: string, sourceTeamId: string) {
  const source = await prisma.teams.findUnique({
    where: { id: sourceTeamId },
    include: {
      organisation: { select: { name: true } },
      members: true,
    },
  });
  if (!source) throw new Error("Source team not found.");
  if (source.organisationId === targetOrgId) {
    throw new Error("Cannot import a team from the same organisation.");
  }

  const slug = await uniqueTeamSlugInOrg(targetOrgId, source.slug);
  const newTeam = await prisma.teams.create({
    data: {
      organisationId: targetOrgId,
      name: source.name,
      slug,
      description:
        source.description ??
        `Imported from ${source.organisation.name} (${source.slug}).`,
    },
  });

  let imported = 0;
  for (const member of source.members) {
    const orgMemberCount = await prisma.organisationUsers.count({
      where: { organisationId: targetOrgId },
    });
    const inOrg = await prisma.organisationUsers.findUnique({
      where: {
        userId_organisationId: { userId: member.userId, organisationId: targetOrgId },
      },
    });
    if (!inOrg) {
      await portalAddOrgMember(
        targetOrgId,
        member.userId,
        defaultOrgRoleForNewMember(orgMemberCount),
      );
    }
    await prisma.teamMembers.upsert({
      where: { teamId_userId: { teamId: newTeam.id, userId: member.userId } },
      create: { teamId: newTeam.id, userId: member.userId, role: member.role },
      update: { role: member.role },
    });
    await ensureDefaultTeam(prisma, member.userId, newTeam.id);
    imported++;
  }

  return { team: newTeam, imported };
}

export async function portalDeleteTeam(orgId: string, teamId: string) {
  const team = await prisma.teams.findFirst({
    where: { id: teamId, organisationId: orgId },
  });
  if (!team) throw new Error("Team not found in this organisation.");
  await prisma.teams.delete({ where: { id: teamId } });
  return team.name;
}

export async function portalAddTeamMember(
  orgId: string,
  teamId: string,
  emailOrUserId: string,
  teamRole?: string,
) {
  const team = await prisma.teams.findFirst({
    where: { id: teamId, organisationId: orgId },
  });
  if (!team) throw new Error("Team not found in this organisation.");

  let targetUserId = emailOrUserId.trim();
  if (targetUserId.includes("@")) {
    const found = await prisma.user.findFirst({ where: { email: targetUserId } });
    if (!found) throw new Error("No user found with that email address.");
    targetUserId = found.id;
  }

  const role = teamRole ? assertTeamRole(teamRole) : "team_member";

  const inOrg = await prisma.organisationUsers.findUnique({
    where: {
      userId_organisationId: { userId: targetUserId, organisationId: orgId },
    },
  });
  if (!inOrg) {
    const orgMemberCount = await prisma.organisationUsers.count({
      where: { organisationId: orgId },
    });
    await portalAddOrgMember(
      orgId,
      targetUserId,
      defaultOrgRoleForNewMember(orgMemberCount),
    );
  }

  const existing = await prisma.teamMembers.findUnique({
    where: { teamId_userId: { teamId, userId: targetUserId } },
  });
  if (existing) throw new Error("User is already a member of this team.");

  await prisma.teamMembers.create({
    data: { teamId, userId: targetUserId, role },
  });
  await ensureDefaultTeam(prisma, targetUserId, teamId);
}

export async function portalRemoveTeamMember(
  orgId: string,
  teamId: string,
  userId: string,
) {
  const team = await prisma.teams.findFirst({
    where: { id: teamId, organisationId: orgId },
  });
  if (!team) throw new Error("Team not found in this organisation.");

  // Ensure the user remains in at least one team within the org
  const teamCount = await prisma.teamMembers.count({
    where: { userId, team: { organisationId: orgId } },
  });
  if (teamCount <= 1) {
    throw new Error(
      "User must belong to at least one team in the organisation. Remove them from the organisation instead.",
    );
  }

  try {
    await prisma.teamMembers.delete({
      where: { teamId_userId: { teamId, userId } },
    });
  } catch {
    throw new Error("User is not a member of this team.");
  }
}

export async function portalUpdateTeamMemberRole(
  orgId: string,
  teamId: string,
  userId: string,
  role: string,
) {
  const team = await prisma.teams.findFirst({
    where: { id: teamId, organisationId: orgId },
  });
  if (!team) throw new Error("Team not found in this organisation.");
  assertTeamRole(role);
  try {
    await prisma.teamMembers.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role },
    });
  } catch {
    throw new Error("User is not a member of this team.");
  }
}
