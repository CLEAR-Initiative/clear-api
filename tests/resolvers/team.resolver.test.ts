/**
 * Unit tests for team-member role validation and the
 * `requireTeamAdminOrOrgAdmin` permission helper.
 *
 * DB-free: all `prisma.*` calls are mocked. These cover:
 *   1. `addTeamMember` defaults role to "team_member" when not supplied,
 *      and rejects unknown role strings.
 *   2. `updateTeamMemberRole` rejects unknown role strings, and accepts
 *      every value in the canonical 3-role list.
 *   3. The permission helper that gates `addTeamMember` /
 *      `removeTeamMember` / `updateTeamMemberRole` grants when the caller
 *      is a global admin, an org_admin, or a team_admin, and denies
 *      otherwise. Legacy roles (`owner`, org `admin`, `lead`) were folded
 *      into the new taxonomy by the Phase-3 backfill and no longer bypass.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { teamResolvers } from "../../src/resolvers/team.resolver.js";
import type { Context } from "../../src/context.js";

const TEAM_ID = "t1";
const ORG_ID = "o1";
const TARGET_USER_ID = "u-target";

interface MockPrismaOptions {
  /** Caller's team-membership row (null = not a team member). */
  callerTeamMembership?: { role: string } | null;
  /** Caller's org-membership row (null = not an org member). */
  callerOrgMembership?: { role: string } | null;
  /** Target user's org-membership row. Defaults to "member" so the
   *  org-member precondition in `addTeamMember` passes. */
  targetOrgMembership?: { role: string } | null;
}

/**
 * Builds a Context whose prisma stubs satisfy team.resolver lookups.
 * `teams.findUnique` always returns a team in ORG_ID. `teamMembers` and
 * `organisationUsers` lookups are routed by the userId so the caller's
 * and target's membership rows can be configured independently.
 */
function buildContext(
  caller: { id: string; role: string } | null,
  opts: MockPrismaOptions = {},
): { ctx: Context; createSpy: ReturnType<typeof vi.fn>; updateSpy: ReturnType<typeof vi.fn> } {
  const callerId = caller?.id ?? "u-caller";
  const {
    callerTeamMembership = null,
    callerOrgMembership = null,
    targetOrgMembership = { role: "member" },
  } = opts;

  const createSpy = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "tm-new",
    ...args.data,
  }));
  const updateSpy = vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => ({
    id: "tm-existing",
    ...args.data,
  }));

  // `addTeamMember` also seeds the target user's defaultTeamId via
  // `ensureDefaultTeam`, which reads user.defaultTeamId and (when null)
  // verifies the target membership exists before writing. The stubs
  // below just say "already has a default" so the seed call is a no-op
  // and doesn't clutter these role-focused assertions.
  const userFindUnique = vi.fn(async () => ({ defaultTeamId: "t-seed" }));
  const userUpdate = vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => ({
    id: "u-target",
    ...args.data,
  }));

  const prisma = {
    teams: {
      findUnique: vi.fn(async () => ({ id: TEAM_ID, organisationId: ORG_ID })),
    },
    teamMembers: {
      findUnique: vi.fn(async (args: { where: { teamId_userId: { teamId: string; userId: string } } }) => {
        if (args.where.teamId_userId.userId === callerId) return callerTeamMembership;
        return null;
      }),
      create: createSpy,
      update: updateSpy,
    },
    organisationUsers: {
      findUnique: vi.fn(async (args: { where: { userId_organisationId: { userId: string; organisationId: string } } }) => {
        if (args.where.userId_organisationId.userId === callerId) return callerOrgMembership;
        if (args.where.userId_organisationId.userId === TARGET_USER_ID) return targetOrgMembership;
        return null;
      }),
    },
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
  };

  const ctx = {
    prisma,
    user: caller as Context["user"],
    session: null,
    authMethod: caller ? "session" : null,
  } as unknown as Context;

  return { ctx, createSpy, updateSpy };
}

const addTeamMember = teamResolvers.Mutation.addTeamMember;
const updateTeamMemberRole = teamResolvers.Mutation.updateTeamMemberRole;

// Roles a caller can hold and still be allowed to manage members.
const ADMIN_CALLER_CASES: Array<{ label: string; caller: { id: string; role: string }; opts: MockPrismaOptions }> = [
  {
    label: "global admin",
    caller: { id: "u-caller", role: "admin" },
    opts: {},
  },
  {
    label: "org_admin",
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerOrgMembership: { role: "org_admin" } },
  },
  {
    label: "team_admin",
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerTeamMembership: { role: "team_admin" } },
  },
];

// Non-admin team roles — these callers must NOT be able to manage members.
// Only the two lower team roles left after Phase 3.
const NON_ADMIN_TEAM_ROLES = ["field_coordinator", "team_member"];

// Canonical team roles the resolver still accepts as input.
const CANONICAL_TEAM_ROLES = ["team_admin", "field_coordinator", "team_member"];

describe("addTeamMember — role validation", () => {
  it('defaults role to "team_member" when none is supplied', async () => {
    const { ctx, createSpy } = buildContext(
      { id: "u-caller", role: "admin" },
    );
    await addTeamMember(undefined, { teamId: TEAM_ID, userId: TARGET_USER_ID }, ctx);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]?.data).toMatchObject({
      teamId: TEAM_ID,
      userId: TARGET_USER_ID,
      role: "team_member",
    });
  });

  it("accepts every canonical role", async () => {
    for (const role of CANONICAL_TEAM_ROLES) {
      const { ctx, createSpy } = buildContext(
        { id: "u-caller", role: "admin" },
      );
      await addTeamMember(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role },
        ctx,
      );
      expect(createSpy.mock.calls[0]?.[0]?.data?.role).toBe(role);
    }
  });

  it("rejects an unknown role and does not call prisma.teamMembers.create", async () => {
    const { ctx, createSpy } = buildContext(
      { id: "u-caller", role: "admin" },
    );
    await expect(
      addTeamMember(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "manager" },
        ctx,
      ),
    ).rejects.toThrow(GraphQLError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects the legacy team role "lead" so old clients get a clear error', async () => {
    const { ctx, createSpy } = buildContext(
      { id: "u-caller", role: "admin" },
    );
    await expect(
      addTeamMember(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "lead" },
        ctx,
      ),
    ).rejects.toThrow(/Invalid team role/i);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("updateTeamMemberRole — role validation", () => {
  it("rejects an unknown role and does not call prisma.teamMembers.update", async () => {
    const { ctx, updateSpy } = buildContext({ id: "u-caller", role: "admin" });
    await expect(
      updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "supervisor" },
        ctx,
      ),
    ).rejects.toThrow(GraphQLError);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("accepts every canonical role", async () => {
    for (const role of CANONICAL_TEAM_ROLES) {
      const { ctx, updateSpy } = buildContext({ id: "u-caller", role: "admin" });
      await updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role },
        ctx,
      );
      expect(updateSpy.mock.calls[0]?.[0]?.data).toEqual({ role });
    }
  });

  it('rejects the legacy team roles ("lead", "analyst", "viewer") so callers get a clear error', async () => {
    for (const role of ["lead", "analyst", "viewer"]) {
      const { ctx, updateSpy } = buildContext({ id: "u-caller", role: "admin" });
      await expect(
        updateTeamMemberRole(
          undefined,
          { teamId: TEAM_ID, userId: TARGET_USER_ID, role },
          ctx,
        ),
      ).rejects.toThrow(/Invalid team role/i);
      expect(updateSpy).not.toHaveBeenCalled();
    }
  });
});

describe("requireTeamAdminOrOrgAdmin (via updateTeamMemberRole)", () => {
  for (const { label, caller, opts } of ADMIN_CALLER_CASES) {
    it(`allows ${label}`, async () => {
      const { ctx, updateSpy } = buildContext(caller, opts);
      await updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "team_member" },
        ctx,
      );
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
  }

  for (const role of NON_ADMIN_TEAM_ROLES) {
    it(`denies a caller whose team role is "${role}"`, async () => {
      const { ctx, updateSpy } = buildContext(
        { id: "u-caller", role: "viewer" },
        { callerTeamMembership: { role } },
      );
      await expect(
        updateTeamMemberRole(
          undefined,
          { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "team_member" },
          ctx,
        ),
      ).rejects.toThrow(/team admin or org admin/i);
      expect(updateSpy).not.toHaveBeenCalled();
    });
  }

  it('denies a caller whose org role is "member"', async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-caller", role: "viewer" },
      { callerOrgMembership: { role: "member" } },
    );
    await expect(
      updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "team_member" },
        ctx,
      ),
    ).rejects.toThrow(/team admin or org admin/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('denies the legacy org "owner" role now that it has been folded into org_admin', async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-caller", role: "viewer" },
      { callerOrgMembership: { role: "owner" } },
    );
    await expect(
      updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role: "team_member" },
        ctx,
      ),
    ).rejects.toThrow(/team admin or org admin/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
