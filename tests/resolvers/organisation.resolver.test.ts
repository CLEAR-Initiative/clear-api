/**
 * Unit tests for `organisation.resolver.ts`.
 *
 * DB-free: every `context.prisma.*` delegate the resolver touches is stubbed
 * per-test with `vi.fn()`. No real Prisma client, no database, and the
 * `describeIfDb` helper is intentionally NOT used — these run in CI without a DB.
 *
 * Covered (branches with real logic):
 *   - Query.myOrganisations: global-admin sees-all branch vs. membership-scoped
 *     branch (asserts the `id: { in: [...] }` filter is built from memberships);
 *     auth gate.
 *   - Query.organisation: NOT_FOUND→null, admin bypass, member allowed,
 *     non-member FORBIDDEN; auth gate.
 *   - Mutation.createOrganisation: admin-only requireRole gate, duplicate-slug
 *     BAD_USER_INPUT, and the $transaction that creates the org + default team.
 *   - Mutation.deleteOrganisation: admin-only gate, NOT_FOUND, happy path.
 *   - Mutation.updateOrganisation: auth gate, NOT_FOUND, requireOrgAdmin gate,
 *     happy path passes input through to update.
 *   - Mutation.addOrgMember: requireOrgAdmin gate, email→userId resolution
 *     (found / not-found BAD_USER_INPUT), role default "member", and the
 *     auto-route-into-default-team transaction logic (1 team vs. 2 teams).
 *   - Mutation.removeOrgMember: requireOrgAdmin gate, happy path,
 *     P2025-not-found → false, other errors rethrown.
 *   - requireOrgAdmin (exercised via mutations): global-admin bypass,
 *     owner/admin allowed, member/non-member FORBIDDEN.
 *
 * Deliberately skipped (trivial passthroughs with no logic):
 *   - Organisation.teams / Organisation.members and OrgMember.user — each is a
 *     single `prisma.x.findMany/findUnique` keyed on a parent id, no branching.
 */

import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { organisationResolvers } from "../../src/resolvers/organisation.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;

function buildContext(
  user: User,
  prisma: Record<string, unknown> = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { myOrganisations, organisation } = organisationResolvers.Query;
const {
  createOrganisation,
  deleteOrganisation,
  updateOrganisation,
  addOrgMember,
  removeOrgMember,
} = organisationResolvers.Mutation;

describe("Query.myOrganisations", () => {
  it("returns ALL organisations for a global admin (no membership lookup)", async () => {
    const all = [{ id: "o1" }, { id: "o2" }];
    const findManyOrgs = vi.fn().mockResolvedValue(all);
    const findManyMemberships = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findMany: findManyOrgs },
        organisationUsers: { findMany: findManyMemberships },
      },
    );

    const result = await myOrganisations(null, {}, ctx);

    expect(result).toBe(all);
    expect(findManyOrgs).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
    expect(findManyMemberships).not.toHaveBeenCalled();
  });

  it("scopes to the caller's memberships for a non-admin", async () => {
    const findManyMemberships = vi
      .fn()
      .mockResolvedValue([{ organisationId: "o1" }, { organisationId: "o3" }]);
    const orgs = [{ id: "o1" }, { id: "o3" }];
    const findManyOrgs = vi.fn().mockResolvedValue(orgs);
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: { findMany: findManyOrgs },
        organisationUsers: { findMany: findManyMemberships },
      },
    );

    const result = await myOrganisations(null, {}, ctx);

    expect(result).toBe(orgs);
    expect(findManyMemberships).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { organisationId: true },
    });
    expect(findManyOrgs).toHaveBeenCalledWith({
      where: { id: { in: ["o1", "o3"] } },
    });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(myOrganisations(null, {}, buildContext(null))).rejects.toThrow(
      GraphQLError,
    );
  });
});

describe("Query.organisation", () => {
  it("returns null when the org does not exist", async () => {
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { organisations: { findUnique: vi.fn().mockResolvedValue(null) } },
    );
    expect(await organisation(null, { id: "missing" }, ctx)).toBeNull();
  });

  it("returns the org for a global admin without a membership lookup", async () => {
    const org = { id: "o1" };
    const membershipFindUnique = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue(org) },
        organisationUsers: { findUnique: membershipFindUnique },
      },
    );

    expect(await organisation(null, { id: "o1" }, ctx)).toBe(org);
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it("returns the org for a member", async () => {
    const org = { id: "o1" };
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue(org) },
        organisationUsers: {
          findUnique: vi.fn().mockResolvedValue({ role: "member" }),
        },
      },
    );

    expect(await organisation(null, { id: "o1" }, ctx)).toBe(org);
  });

  it("throws FORBIDDEN for a non-member non-admin", async () => {
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1" }) },
        organisationUsers: { findUnique: vi.fn().mockResolvedValue(null) },
      },
    );
    await expect(organisation(null, { id: "o1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      organisation(null, { id: "o1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.createOrganisation", () => {
  it("creates the org and a same-named default team in one transaction", async () => {
    const createdOrg = { id: "o1", name: "Acme", slug: "acme" };
    const orgCreate = vi.fn().mockResolvedValue(createdOrg);
    const teamCreate = vi.fn().mockResolvedValue({ id: "t1" });
    const tx = {
      organisations: { create: orgCreate },
      teams: { create: teamCreate },
    };
    const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction,
      },
    );

    const result = await createOrganisation(
      null,
      { input: { name: "Acme", slug: "acme" } },
      ctx,
    );

    expect(result).toBe(createdOrg);
    expect(orgCreate).toHaveBeenCalledWith({
      data: { name: "Acme", slug: "acme" },
    });
    expect(teamCreate.mock.calls[0][0].data).toMatchObject({
      organisationId: "o1",
      name: "Acme",
      slug: "acme",
    });
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    const $transaction = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: { findUnique: vi.fn() },
        $transaction,
      },
    );
    await expect(
      createOrganisation(null, { input: { name: "A", slug: "a" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when the slug already exists", async () => {
    const $transaction = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1" }) },
        $transaction,
      },
    );
    await expect(
      createOrganisation(null, { input: { name: "A", slug: "acme" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      createOrganisation(null, { input: { name: "A", slug: "a" } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.deleteOrganisation", () => {
  it("deletes an existing org and returns true", async () => {
    const del = vi.fn().mockResolvedValue({ id: "o1" });
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: {
          findUnique: vi.fn().mockResolvedValue({ id: "o1" }),
          delete: del,
        },
      },
    );

    expect(await deleteOrganisation(null, { id: "o1" }, ctx)).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "o1" } });
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    const del = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      { organisations: { findUnique: vi.fn(), delete: del } },
    );
    await expect(
      deleteOrganisation(null, { id: "o1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the org does not exist", async () => {
    const del = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue(null), delete: del },
      },
    );
    await expect(
      deleteOrganisation(null, { id: "missing" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      deleteOrganisation(null, { id: "o1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.updateOrganisation", () => {
  it("updates an org when the caller is an org admin, passing input through", async () => {
    const updated = { id: "o1", name: "New" };
    const update = vi.fn().mockResolvedValue(updated);
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: {
          findUnique: vi.fn().mockResolvedValue({ id: "o1" }),
          update,
        },
        organisationUsers: {
          findUnique: vi.fn().mockResolvedValue({ role: "admin" }),
        },
      },
    );

    const result = await updateOrganisation(
      null,
      { id: "o1", input: { name: "New" } },
      ctx,
    );

    expect(result).toBe(updated);
    expect(update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: { name: "New" },
    });
  });

  it("lets a global admin update without an org membership", async () => {
    const update = vi.fn().mockResolvedValue({ id: "o1" });
    const membershipFindUnique = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: {
          findUnique: vi.fn().mockResolvedValue({ id: "o1" }),
          update,
        },
        organisationUsers: { findUnique: membershipFindUnique },
      },
    );

    await updateOrganisation(null, { id: "o1", input: { isActive: false } }, ctx);
    expect(update).toHaveBeenCalledOnce();
    expect(membershipFindUnique).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the org does not exist", async () => {
    const update = vi.fn();
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue(null), update },
      },
    );
    await expect(
      updateOrganisation(null, { id: "missing", input: { name: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when the caller is only a plain member", async () => {
    const update = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1" }), update },
        organisationUsers: {
          findUnique: vi.fn().mockResolvedValue({ role: "member" }),
        },
      },
    );
    await expect(
      updateOrganisation(null, { id: "o1", input: { name: "x" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      updateOrganisation(null, { id: "o1", input: {} }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.addOrgMember", () => {
  /** Builds prisma stubs for the addOrgMember transaction path. */
  function buildAddCtx(opts: {
    caller: User;
    callerOrgRole?: string | null; // org membership role for requireOrgAdmin
    foundUserByEmail?: { id: string } | null;
    teams?: Array<{ id: string }>;
  }) {
    const orgUserCreate = vi.fn(async (a: { data: Record<string, unknown> }) => ({
      id: "ou1",
      ...a.data,
    }));
    const teamUpsert = vi.fn().mockResolvedValue({});
    const teamsFindMany = vi.fn().mockResolvedValue(opts.teams ?? []);
    const userFindFirst = vi
      .fn()
      .mockResolvedValue(opts.foundUserByEmail ?? null);

    const tx = {
      organisationUsers: { create: orgUserCreate },
      teams: { findMany: teamsFindMany },
      teamMembers: { upsert: teamUpsert },
    };

    const ctx = buildContext(opts.caller, {
      organisationUsers: {
        // requireOrgAdmin lookup
        findUnique: vi.fn().mockResolvedValue(
          opts.callerOrgRole === undefined
            ? null
            : opts.callerOrgRole === null
              ? null
              : { role: opts.callerOrgRole },
        ),
      },
      user: { findFirst: userFindFirst },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    });

    return { ctx, orgUserCreate, teamUpsert, teamsFindMany, userFindFirst };
  }

  it("adds a member with the given role and auto-routes into the sole team", async () => {
    const { ctx, orgUserCreate, teamUpsert } = buildAddCtx({
      caller: { id: "admin1", role: "admin" },
      teams: [{ id: "t1" }],
    });

    await addOrgMember(null, { orgId: "o1", userId: "u-target", role: "admin" }, ctx);

    expect(orgUserCreate.mock.calls[0][0].data).toEqual({
      userId: "u-target",
      organisationId: "o1",
      role: "admin",
    });
    expect(teamUpsert).toHaveBeenCalledOnce();
    expect(teamUpsert.mock.calls[0][0]).toMatchObject({
      where: { teamId_userId: { teamId: "t1", userId: "u-target" } },
      create: { teamId: "t1", userId: "u-target", role: "viewer" },
    });
  });

  it('defaults role to "member" when not supplied', async () => {
    const { ctx, orgUserCreate } = buildAddCtx({
      caller: { id: "admin1", role: "admin" },
      teams: [],
    });
    await addOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx);
    expect(orgUserCreate.mock.calls[0][0].data.role).toBe("member");
  });

  it("does NOT auto-route when the org has more than one team", async () => {
    const { ctx, teamUpsert } = buildAddCtx({
      caller: { id: "admin1", role: "admin" },
      teams: [{ id: "t1" }, { id: "t2" }],
    });
    await addOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx);
    expect(teamUpsert).not.toHaveBeenCalled();
  });

  it("resolves an email argument to a user id before creating the membership", async () => {
    const { ctx, orgUserCreate, userFindFirst } = buildAddCtx({
      caller: { id: "admin1", role: "admin" },
      foundUserByEmail: { id: "resolved-id" },
      teams: [],
    });

    await addOrgMember(null, { orgId: "o1", userId: "jane@example.com" }, ctx);

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { email: "jane@example.com" },
    });
    expect(orgUserCreate.mock.calls[0][0].data.userId).toBe("resolved-id");
  });

  it("throws BAD_USER_INPUT when the email matches no user", async () => {
    const { ctx, orgUserCreate } = buildAddCtx({
      caller: { id: "admin1", role: "admin" },
      foundUserByEmail: null,
    });
    await expect(
      addOrgMember(null, { orgId: "o1", userId: "nobody@example.com" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(orgUserCreate).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when the caller is not an org owner/admin", async () => {
    const { ctx, orgUserCreate } = buildAddCtx({
      caller: { id: "u1", role: "viewer" },
      callerOrgRole: "member",
    });
    await expect(
      addOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(orgUserCreate).not.toHaveBeenCalled();
  });

  it("allows an org owner (non-global-admin) to add a member", async () => {
    const { ctx, orgUserCreate } = buildAddCtx({
      caller: { id: "u1", role: "viewer" },
      callerOrgRole: "owner",
      teams: [],
    });
    await addOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx);
    expect(orgUserCreate).toHaveBeenCalledOnce();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      addOrgMember(null, { orgId: "o1", userId: "u" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

describe("Mutation.removeOrgMember", () => {
  it("deletes the membership and returns true", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      {
        organisationUsers: {
          findUnique: vi.fn().mockResolvedValue({ role: "admin" }),
          delete: del,
        },
      },
    );

    expect(await removeOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx)).toBe(
      true,
    );
    expect(del).toHaveBeenCalledWith({
      where: { userId_organisationId: { userId: "u-target", organisationId: "o1" } },
    });
  });

  it("returns false when the membership does not exist (Prisma P2025)", async () => {
    const err = Object.assign(new Error("Record not found"), { code: "P2025" });
    const del = vi.fn().mockRejectedValue(err);
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      { organisationUsers: { findUnique: vi.fn(), delete: del } },
    );

    expect(await removeOrgMember(null, { orgId: "o1", userId: "gone" }, ctx)).toBe(
      false,
    );
  });

  it("rethrows non-P2025 errors", async () => {
    const err = Object.assign(new Error("boom"), { code: "P9999" });
    const del = vi.fn().mockRejectedValue(err);
    const ctx = buildContext(
      { id: "admin1", role: "admin" },
      { organisationUsers: { findUnique: vi.fn(), delete: del } },
    );

    await expect(
      removeOrgMember(null, { orgId: "o1", userId: "u" }, ctx),
    ).rejects.toThrow("boom");
  });

  it("throws FORBIDDEN when the caller is not an org owner/admin", async () => {
    const del = vi.fn();
    const ctx = buildContext(
      { id: "u1", role: "viewer" },
      {
        organisationUsers: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: del,
        },
      },
    );
    await expect(
      removeOrgMember(null, { orgId: "o1", userId: "u-target" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      removeOrgMember(null, { orgId: "o1", userId: "u" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});
