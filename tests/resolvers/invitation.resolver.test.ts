/**
 * Unit tests for `invitation.resolver.ts` (organisation/team invitation flow).
 *
 * DB-free: `context.prisma` is stubbed per-test with only the delegates each
 * resolver actually calls. The messaging registry + templates and the Better
 * Auth client are `vi.mock`-ed BEFORE the resolver is imported, so no real
 * email is sent and no DB / network connection is attempted.
 *
 * Coverage:
 *   - requireOrgAdmin auth gate (UNAUTHENTICATED / global-admin bypass /
 *     org-member FORBIDDEN) exercised through the resolvers that use it.
 *   - Query.pendingInvites: admin gate + the active-only filter passed to prisma.
 *   - Query.invitationByToken: NOT_FOUND→null, multi-team payload, legacy
 *     single-team fallback, and the pending/accepted/expired status machine.
 *   - Mutation.inviteUser: empty-teams validation, org/team NOT_FOUND, existing
 *     org member fast-path (direct team add, no invite email, "already in all
 *     teams" guard), duplicate pending-invite guard, and the happy path
 *     (invite created + email sent).
 *   - Mutation.acceptInvite: invalid token, already-accepted, expired, new-user
 *     signup + verify, org/team membership creation, legacy teamId fallback.
 *   - Mutation.cancelInvite: NOT_FOUND, admin gate, delete.
 *   - Mutation.resendInvite: NOT_FOUND, admin gate, accepted guard, token reset
 *     + email resend.
 *   - Invitation.status field resolver state machine + team/teams field
 *     resolvers (legacy fallback).
 *
 * Deliberately skipped: the trivial `Invitation.organisation` / `team` /
 * `invitedBy` field resolvers (1-line prisma passthroughs with no logic) beyond
 * the `team` null-guard branch, and the empty `InvitationTeam` resolver object.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

// ─── Mocks (must precede the resolver import) ──────────────────────────────────

const { sendMock, signUpEmailMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  signUpEmailMock: vi.fn(),
}));

vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send: sendMock })),
}));
vi.mock("../../src/services/messaging/templates.js", () => ({
  organisationInvite: () => ({ subject: "invite", textBody: "t", htmlBody: "<p>" }),
  teamInviteNotification: () => ({ subject: "added", textBody: "t", htmlBody: "<p>" }),
}));
vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { signUpEmail: signUpEmailMock } },
}));

import { invitationResolvers } from "../../src/resolvers/invitation.resolver.js";
import type { Context } from "../../src/context.js";

type PrismaStub = Record<string, Record<string, ReturnType<typeof vi.fn>>>;
type User = { id: string; role: string; name?: string } | null;

function buildContext(user: User, prisma: PrismaStub = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { pendingInvites, invitationByToken } = invitationResolvers.Query;
const { inviteUser, acceptInvite, cancelInvite, resendInvite } =
  invitationResolvers.Mutation;
const InvitationFields = invitationResolvers.Invitation;

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
  signUpEmailMock.mockReset();
});

// ─── requireOrgAdmin gate (via pendingInvites) ─────────────────────────────────

describe("requireOrgAdmin gate", () => {
  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      pendingInvites(null, { organisationId: "o1" }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("lets a global admin through without checking membership", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn();
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: { findMany },
      organisationUsers: { findUnique },
    });
    await pendingInvites(null, { organisationId: "o1" }, ctx);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("throws FORBIDDEN when the caller is not an org owner/admin", async () => {
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue({ role: "member" }),
      },
    });
    await expect(
      pendingInvites(null, { organisationId: "o1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws FORBIDDEN when the caller has no membership at all", async () => {
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      organisationUsers: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      pendingInvites(null, { organisationId: "o1" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("lets an org owner through", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "i1" }]);
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
      },
      invitations: { findMany },
    });
    await pendingInvites(null, { organisationId: "o1" }, ctx);
    expect(findMany).toHaveBeenCalledOnce();
  });
});

// ─── Query.pendingInvites ──────────────────────────────────────────────────────

describe("Query.pendingInvites", () => {
  it("queries only active (unaccepted, unexpired) invites for the org", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: { findMany },
    });
    await pendingInvites(null, { organisationId: "o1" }, ctx);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.organisationId).toBe("o1");
    expect(arg.where.acceptedAt).toBeNull();
    expect(arg.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });
});

// ─── Query.invitationByToken ───────────────────────────────────────────────────

describe("Query.invitationByToken", () => {
  it("returns null for an unknown token (no auth required)", async () => {
    const ctx = buildContext(null, {
      invitations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    expect(await invitationByToken(null, { token: "nope" }, ctx)).toBeNull();
  });

  it("maps the multi-team payload and reports pending status", async () => {
    const future = new Date(Date.now() + 60_000);
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisation: { name: "Org" },
          team: null,
          teamId: null,
          teamRole: null,
          role: "member",
          expiresAt: future,
          acceptedAt: null,
          teams: [
            { team: { id: "t1", name: "Alpha" }, teamRole: "editor" },
            { team: { id: "t2", name: "Beta" }, teamRole: "viewer" },
          ],
        }),
      },
    });
    const result = await invitationByToken(null, { token: "tok" }, ctx);
    expect(result).toMatchObject({
      id: "i1",
      organisationName: "Org",
      status: "pending",
      teams: [
        { teamId: "t1", teamName: "Alpha", teamRole: "editor" },
        { teamId: "t2", teamName: "Beta", teamRole: "viewer" },
      ],
    });
  });

  it("falls back to the legacy single team when the join is empty", async () => {
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisation: { name: "Org" },
          team: { name: "Legacy" },
          teamId: "t9",
          teamRole: null,
          role: "member",
          expiresAt: new Date(Date.now() + 60_000),
          acceptedAt: null,
          teams: [],
        }),
      },
    });
    const result = await invitationByToken(null, { token: "tok" }, ctx);
    expect(result!.teams).toEqual([
      { teamId: "t9", teamName: "Legacy", teamRole: "viewer" },
    ]);
  });

  it("reports accepted status when acceptedAt is set", async () => {
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisation: { name: "Org" },
          team: null,
          teamId: null,
          teamRole: null,
          role: "member",
          expiresAt: new Date(Date.now() + 60_000),
          acceptedAt: new Date(),
          teams: [],
        }),
      },
    });
    const result = await invitationByToken(null, { token: "tok" }, ctx);
    expect(result!.status).toBe("accepted");
  });

  it("reports expired status when past expiry and not accepted", async () => {
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisation: { name: "Org" },
          team: null,
          teamId: null,
          teamRole: null,
          role: "member",
          expiresAt: new Date(Date.now() - 60_000),
          acceptedAt: null,
          teams: [],
        }),
      },
    });
    const result = await invitationByToken(null, { token: "tok" }, ctx);
    expect(result!.status).toBe("expired");
  });
});

// ─── Mutation.inviteUser ───────────────────────────────────────────────────────

describe("Mutation.inviteUser", () => {
  const inviter = { id: "a1", role: "admin", name: "Admin" };

  function ctxFor(prisma: PrismaStub) {
    return buildContext(inviter, prisma);
  }

  it("rejects an empty teams list with BAD_USER_INPUT", async () => {
    const ctx = ctxFor({});
    await expect(
      inviteUser(
        null,
        { input: { email: "a@b.dev", organisationId: "o1", teams: [] } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("throws NOT_FOUND when the organisation does not exist", async () => {
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      inviteUser(
        null,
        {
          input: {
            email: "a@b.dev",
            organisationId: "o1",
            teams: [{ teamId: "t1", teamRole: "viewer" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("throws NOT_FOUND when a requested team is not in the org", async () => {
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: { findMany: vi.fn().mockResolvedValue([]) }, // none found
    });
    await expect(
      inviteUser(
        null,
        {
          input: {
            email: "a@b.dev",
            organisationId: "o1",
            teams: [{ teamId: "t1", teamRole: "viewer" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("creates an invitation and sends the email on the happy path", async () => {
    const create = vi.fn().mockResolvedValue({ id: "i1", token: "tok" });
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: {
        findMany: vi.fn().mockResolvedValue([{ id: "t1", name: "Alpha" }]),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) }, // no existing user
      invitations: {
        findFirst: vi.fn().mockResolvedValue(null), // no pending invite
        create,
      },
    });
    const result = await inviteUser(
      null,
      {
        input: {
          email: "a@b.dev",
          organisationId: "o1",
          teams: [{ teamId: "t1", teamRole: "viewer" }],
        },
      },
      ctx,
    );
    expect(result).toEqual({ id: "i1", token: "tok" });
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data;
    expect(data.email).toBe("a@b.dev");
    expect(data.invitedById).toBe("a1");
    expect(typeof data.token).toBe("string");
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(data.teams.create).toEqual([{ teamId: "t1", teamRole: "viewer" }]);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe("a@b.dev");
  });

  it("rejects when a pending invite already exists", async () => {
    const create = vi.fn();
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: { findMany: vi.fn().mockResolvedValue([{ id: "t1", name: "Alpha" }]) },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      invitations: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing" }),
        create,
      },
    });
    await expect(
      inviteUser(
        null,
        {
          input: {
            email: "a@b.dev",
            organisationId: "o1",
            teams: [{ teamId: "t1", teamRole: "viewer" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("fast-paths an existing org member: adds new teams, no invite email", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const inviteCreate = vi.fn().mockResolvedValue({ id: "synthetic" });
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: {
        findMany: vi.fn().mockResolvedValue([
          { id: "t1", name: "Alpha" },
          { id: "t2", name: "Beta" },
        ]),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u9", email: "a@b.dev" }) },
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue({ role: "member" }),
      },
      teamMembers: {
        // Already in t1, so only t2 should be added.
        findMany: vi.fn().mockResolvedValue([{ teamId: "t1" }]),
        createMany,
      },
      invitations: { create: inviteCreate },
    });
    const result = await inviteUser(
      null,
      {
        input: {
          email: "a@b.dev",
          organisationId: "o1",
          teams: [
            { teamId: "t1", teamRole: "viewer" },
            { teamId: "t2", teamRole: "editor" },
          ],
        },
      },
      ctx,
    );
    expect(result).toEqual({ id: "synthetic" });
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0][0].data).toEqual([
      { teamId: "t2", userId: "u9", role: "editor" },
    ]);
    // Synthetic accepted invitation row is created (acceptedAt set).
    expect(inviteCreate.mock.calls[0][0].data.acceptedAt).toBeInstanceOf(Date);
    // A best-effort notification email is sent (not the invite email path).
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it("rejects an existing member already in all requested teams", async () => {
    const createMany = vi.fn();
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: { findMany: vi.fn().mockResolvedValue([{ id: "t1", name: "Alpha" }]) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u9", email: "a@b.dev" }) },
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue({ role: "member" }),
      },
      teamMembers: {
        findMany: vi.fn().mockResolvedValue([{ teamId: "t1" }]),
        createMany,
      },
    });
    await expect(
      inviteUser(
        null,
        {
          input: {
            email: "a@b.dev",
            organisationId: "o1",
            teams: [{ teamId: "t1", teamRole: "viewer" }],
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("dedupes duplicate teamIds before validating team count", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "t1", name: "Alpha" }]);
    const create = vi.fn().mockResolvedValue({ id: "i1" });
    const ctx = ctxFor({
      organisations: { findUnique: vi.fn().mockResolvedValue({ id: "o1", name: "Org" }) },
      teams: { findMany },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      invitations: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    await inviteUser(
      null,
      {
        input: {
          email: "a@b.dev",
          organisationId: "o1",
          teams: [
            { teamId: "t1", teamRole: "viewer" },
            { teamId: "t1", teamRole: "viewer" },
          ],
        },
      },
      ctx,
    );
    // Deduped to a single id, so the `length !== length` NOT_FOUND guard passes.
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(["t1"]);
    expect(create).toHaveBeenCalledOnce();
  });
});

// ─── Mutation.acceptInvite ─────────────────────────────────────────────────────

describe("Mutation.acceptInvite", () => {
  const input = { token: "tok", name: "New", password: "longenough" };

  it("throws NOT_FOUND for an invalid token", async () => {
    const ctx = buildContext(null, {
      invitations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(acceptInvite(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("rejects an already-accepted invitation", async () => {
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          acceptedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
    });
    await expect(acceptInvite(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("rejects an expired invitation", async () => {
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          acceptedAt: null,
          expiresAt: new Date(Date.now() - 60_000),
        }),
      },
    });
    await expect(acceptInvite(null, { input }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("creates a new user, verifies email, joins org + teams, marks accepted", async () => {
    signUpEmailMock.mockResolvedValue({ user: { id: "u-new" } });
    const userUpdate = vi.fn().mockResolvedValue({ id: "u-new" });
    const findUnique = vi.fn().mockResolvedValue(null); // no existing user
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ id: "u-new", email: "a@b.dev" });
    const orgCreate = vi.fn().mockResolvedValue({});
    const teamUpsert = vi.fn().mockResolvedValue({});
    const invUpdate = vi.fn().mockResolvedValue({});

    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisationId: "o1",
          role: "member",
          teamId: null,
          teamRole: null,
          acceptedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        update: invUpdate,
      },
      user: { findUnique, findUniqueOrThrow, update: userUpdate },
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: orgCreate,
      },
      invitationTeams: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ teamId: "t1", teamRole: "editor" }]),
      },
      teamMembers: { upsert: teamUpsert },
    });

    await expect(acceptInvite(null, { input }, ctx)).resolves.toBe(true);
    expect(signUpEmailMock).toHaveBeenCalledOnce();
    // Email marked verified for the freshly created user.
    expect(userUpdate.mock.calls[0][0].data).toEqual({ emailVerified: true });
    expect(orgCreate).toHaveBeenCalledOnce();
    expect(teamUpsert).toHaveBeenCalledOnce();
    expect(teamUpsert.mock.calls[0][0].create).toEqual({
      teamId: "t1",
      userId: "u-new",
      role: "editor",
    });
    expect(invUpdate.mock.calls[0][0].data.acceptedAt).toBeInstanceOf(Date);
  });

  it("uses the legacy single teamId when the join table is empty, and skips signup for an existing user", async () => {
    const teamUpsert = vi.fn().mockResolvedValue({});
    const orgCreate = vi.fn().mockResolvedValue({});
    const ctx = buildContext(null, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          email: "a@b.dev",
          organisationId: "o1",
          role: "member",
          teamId: "t-legacy",
          teamRole: null,
          acceptedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u9", email: "a@b.dev" }) },
      organisationUsers: {
        findUnique: vi.fn().mockResolvedValue({ role: "member" }), // already a member
        create: orgCreate,
      },
      invitationTeams: { findMany: vi.fn().mockResolvedValue([]) },
      teamMembers: { upsert: teamUpsert },
    });

    await expect(acceptInvite(null, { input }, ctx)).resolves.toBe(true);
    expect(signUpEmailMock).not.toHaveBeenCalled();
    expect(orgCreate).not.toHaveBeenCalled(); // already a member
    expect(teamUpsert.mock.calls[0][0].create).toEqual({
      teamId: "t-legacy",
      userId: "u9",
      role: "viewer", // teamRole null → default viewer
    });
  });
});

// ─── Mutation.cancelInvite ─────────────────────────────────────────────────────

describe("Mutation.cancelInvite", () => {
  it("throws NOT_FOUND when the invitation does not exist", async () => {
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(cancelInvite(null, { id: "i1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("enforces the org-admin gate before deleting", async () => {
    const del = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", organisationId: "o1" }),
        delete: del,
      },
      organisationUsers: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(cancelInvite(null, { id: "i1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the invitation for an authorised admin", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", organisationId: "o1" }),
        delete: del,
      },
    });
    await expect(cancelInvite(null, { id: "i1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "i1" } });
  });
});

// ─── Mutation.resendInvite ─────────────────────────────────────────────────────

describe("Mutation.resendInvite", () => {
  it("throws NOT_FOUND when the invitation does not exist", async () => {
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(resendInvite(null, { id: "i1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("rejects resending an already-accepted invitation", async () => {
    const update = vi.fn();
    const ctx = buildContext({ id: "a1", role: "admin" }, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          organisationId: "o1",
          email: "a@b.dev",
          role: "member",
          acceptedAt: new Date(),
          organisation: { name: "Org" },
          team: null,
        }),
        update,
      },
    });
    await expect(resendInvite(null, { id: "i1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(update).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("resets the token/expiry and resends the email on the happy path", async () => {
    const update = vi.fn().mockResolvedValue({ id: "i1", token: "new" });
    const ctx = buildContext({ id: "a1", role: "admin", name: "Admin" }, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          organisationId: "o1",
          email: "a@b.dev",
          role: "member",
          acceptedAt: null,
          organisation: { name: "Org" },
          team: { name: "Alpha" },
        }),
        update,
      },
    });
    const result = await resendInvite(null, { id: "i1" }, ctx);
    expect(result).toEqual({ id: "i1", token: "new" });
    const data = update.mock.calls[0][0].data;
    expect(typeof data.token).toBe("string");
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe("a@b.dev");
  });

  it("enforces the org-admin gate", async () => {
    const update = vi.fn();
    const ctx = buildContext({ id: "u1", role: "viewer" }, {
      invitations: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          organisationId: "o1",
          email: "a@b.dev",
          role: "member",
          acceptedAt: null,
          organisation: { name: "Org" },
          team: null,
        }),
        update,
      },
      organisationUsers: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(resendInvite(null, { id: "i1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(update).not.toHaveBeenCalled();
  });
});

// ─── Invitation field resolvers ────────────────────────────────────────────────

describe("Invitation field resolvers", () => {
  it("status: pending / accepted / expired", () => {
    expect(
      InvitationFields.status({
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe("pending");
    expect(
      InvitationFields.status({
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe("accepted");
    expect(
      InvitationFields.status({
        acceptedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      }),
    ).toBe("expired");
  });

  it("team: returns null without a DB hit when teamId is null", () => {
    const findUnique = vi.fn();
    const ctx = buildContext(null, { teams: { findUnique } });
    expect(InvitationFields.team({ teamId: null }, {}, ctx)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("teams: maps join rows when present", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { team: { id: "t1", name: "Alpha" }, teamRole: "editor" },
    ]);
    const ctx = buildContext(null, { invitationTeams: { findMany } });
    const result = await InvitationFields.teams(
      { id: "i1", teamId: null, teamRole: null },
      {},
      ctx,
    );
    expect(result).toEqual([{ team: { id: "t1", name: "Alpha" }, teamRole: "editor" }]);
  });

  it("teams: legacy fallback to single teamId when the join is empty", async () => {
    const ctx = buildContext(null, {
      invitationTeams: { findMany: vi.fn().mockResolvedValue([]) },
      teams: { findUnique: vi.fn().mockResolvedValue({ id: "t9", name: "Legacy" }) },
    });
    const result = await InvitationFields.teams(
      { id: "i1", teamId: "t9", teamRole: null },
      {},
      ctx,
    );
    expect(result).toEqual([{ team: { id: "t9", name: "Legacy" }, teamRole: "viewer" }]);
  });

  it("teams: returns an empty array when neither join nor legacy teamId exists", async () => {
    const ctx = buildContext(null, {
      invitationTeams: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const result = await InvitationFields.teams(
      { id: "i1", teamId: null, teamRole: null },
      {},
      ctx,
    );
    expect(result).toEqual([]);
  });
});
