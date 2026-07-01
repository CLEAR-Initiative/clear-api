/**
 * Seed a user's `defaultTeamId` from a team they've just been added to,
 * but only when they don't already have one.
 *
 * Why: several downstream surfaces (notably /observe and the manual-signal
 * modal) rely on `user.defaultTeamId` to satisfy `createManualSignal`'s
 * team-scoped authorisation gate. Without a seed step, a field
 * coordinator who accepts an invite and lands on /observe hits FORBIDDEN
 * because the client has no team hint to send.
 *
 * Contract:
 *   - No-op when the user already has a defaultTeamId (never overwrites).
 *   - No-op when the target teamId isn't a valid team the user is a
 *     member of — that's a defensive check to avoid setting a default
 *     the user has no read access to.
 *   - Best-effort: logs and swallows failures so a transient DB error in
 *     the seed doesn't roll back the invite acceptance / member add
 *     that triggered it.
 */

import type { PrismaClient } from "../generated/prisma/client.js";

export async function ensureDefaultTeam(
  prisma: PrismaClient,
  userId: string,
  teamId: string,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { defaultTeamId: true },
    });
    if (!user || user.defaultTeamId) return;

    // Confirm the caller actually has this membership before pinning it
    // as the default. Guards against stale caller state (e.g. a signal
    // that the membership creation raced with).
    const membership = await prisma.teamMembers.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { teamId: true },
    });
    if (!membership) return;

    await prisma.user.update({
      where: { id: userId },
      data: { defaultTeamId: teamId },
    });
  } catch (err) {
    console.error(
      `[ensureDefaultTeam] failed to seed default team for user=${userId} team=${teamId}:`,
      err,
    );
  }
}
