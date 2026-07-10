/**
 * Shared org-membership operations used by both the GraphQL
 * `removeOrgMember` resolver and the SuperAdmin portal's
 * `portalRemoveOrgMember`. One implementation, no drift on the
 * cascade behaviour.
 *
 * The invariant this helper enforces is one-way:
 *
 *   Removing a user from an organisation ALSO removes every
 *   `teamMembers` row they hold within that org.
 *
 * The reverse direction — "removing a user from their last team also
 * removes them from the org" — is deliberately NOT implemented here.
 * The SuperAdmin portal refuses that case with a message directing
 * the operator to use "Remove from organisation" instead; silent
 * cascade from a team button would surprise them. The GraphQL
 * `removeTeamMember` mutation matches that decision by not
 * cascading either — programmatic callers get the same explicit
 * two-step: remove from org (which then cascades team memberships).
 */

import type { PrismaClient } from "../generated/prisma/client.js";

/** Prisma throws `code: "P2025"` when a delete targets a non-existent
 *  row. Local type guard so the helper can return no-op cleanly
 *  instead of rethrowing an internal-shape error to the caller. */
function isRecordNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code: string }).code === "P2025"
  );
}

export interface RemoveOrgMemberResult {
  /** true when the delete succeeded (org row existed). */
  removed: boolean;
  /** Number of team memberships also removed as part of the cascade. */
  removedTeamCount: number;
}

/**
 * Remove a user from an organisation; cascade any team memberships
 * they hold within that org.
 *
 * The two deletes go in a transaction so partial state (org gone,
 * teams still there, or vice versa) is impossible.
 */
export async function removeOrgMember(
  prisma: PrismaClient,
  args: { organisationId: string; userId: string },
): Promise<RemoveOrgMemberResult> {
  return prisma.$transaction(async (tx) => {
    try {
      await tx.organisationUsers.delete({
        where: {
          userId_organisationId: {
            userId: args.userId,
            organisationId: args.organisationId,
          },
        },
      });
    } catch (e) {
      if (isRecordNotFound(e)) {
        return { removed: false, removedTeamCount: 0 };
      }
      throw e;
    }

    const { count } = await tx.teamMembers.deleteMany({
      where: {
        userId: args.userId,
        team: { organisationId: args.organisationId },
      },
    });

    return { removed: true, removedTeamCount: count };
  });
}
