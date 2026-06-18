/**
 * Unit tests for team-member role validation and the
 * `requireTeamAdminOrOrgAdmin` permission helper.
 *
 * DB-free: all `prisma.*` calls are mocked. These cover:
 *   1. `addTeamMember` defaults role to "viewer" when not supplied, and
 *      rejects unknown role strings.
 *   2. `updateTeamMemberRole` rejects unknown role strings, and accepts
 *      every value in the canonical 6-role list.
 *   3. The permission helper that gates `addTeamMember` /
 *      `removeTeamMember` / `updateTeamMemberRole` grants when the caller
 *      is a global admin, an org owner/admin, or a team-admin (either the
 *      legacy "lead" or the new "team_admin"), and denies otherwise.
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
    label: "org owner",
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerOrgMembership: { role: "owner" } },
  },
  {
    label: "org admin",
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerOrgMembership: { role: "admin" } },
  },
  {
    label: 'legacy team-admin role "lead"',
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerTeamMembership: { role: "lead" } },
  },
  {
    label: 'new team-admin role "team_admin"',
    caller: { id: "u-caller", role: "viewer" },
    opts: { callerTeamMembership: { role: "team_admin" } },
  },
];

// Non-admin team roles — these callers must NOT be able to manage members.
const NON_ADMIN_TEAM_ROLES = ["analyst", "viewer", "field_coordinator", "team_member"];

describe("addTeamMember — role validation", () => {
  it('defaults role to "viewer" when none is supplied', async () => {
    const { ctx, createSpy } = buildContext(
      { id: "u-caller", role: "admin" },
    );
    await addTeamMember(undefined, { teamId: TEAM_ID, userId: TARGET_USER_ID }, ctx);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]?.data).toMatchObject({
      teamId: TEAM_ID,
      userId: TARGET_USER_ID,
      role: "viewer",
    });
  });

  it("accepts every canonical role", async () => {
    for (const role of ["lead", "analyst", "viewer", "team_admin", "field_coordinator", "team_member"]) {
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
    for (const role of ["lead", "analyst", "viewer", "team_admin", "field_coordinator", "team_member"]) {
      const { ctx, updateSpy } = buildContext({ id: "u-caller", role: "admin" });
      await updateTeamMemberRole(
        undefined,
        { teamId: TEAM_ID, userId: TARGET_USER_ID, role },
        ctx,
      );
      expect(updateSpy.mock.calls[0]?.[0]?.data).toEqual({ role });
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
});
