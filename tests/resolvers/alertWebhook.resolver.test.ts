/**
 * Unit tests for the team-scoped clear_alert webhook resolvers
 * (createAlertWebhook / updateAlertWebhook / deleteAlertWebhook /
 * rotateAlertWebhookSecret / teamAlertWebhooks).
 *
 * DB-free: prisma is stubbed. Covers:
 *   - gating: team_admin / org_admin / platform-admin allowed; a plain
 *     member and a non-member are FORBIDDEN (via requireTeamAdminOrOrgAdmin)
 *   - the alert mutations refuse a glitchtip subscription id (NOT_FOUND)
 *   - secret handling: returned on create + rotate, scrubbed on list + update
 */
import { describe, it, expect, vi } from "vitest";
import { GraphQLError } from "graphql";
import { webhookResolvers } from "../../src/resolvers/webhook.resolver.js";
import type { Context } from "../../src/context.js";

const TEAM_ID = "team-1";
const ORG_ID = "org-1";

const DEFAULT_SUB = {
  id: "sub-1",
  source: "clear_alert",
  teamId: TEAM_ID,
  name: "Ops hook",
  targetUrl: "https://hooks.test/clear",
  secret: "stored-secret",
  active: true,
  eventTypeFilter: [],
  alertTypeFilter: [],
  minSeverity: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface Opts {
  teamMembership?: { role: string } | null;
  orgMembership?: { role: string } | null;
  existingSub?: Record<string, unknown> | null;
  listRows?: Array<Record<string, unknown>>;
}

function buildContext(caller: { id: string; role: string } | null, opts: Opts = {}) {
  const {
    teamMembership = null,
    orgMembership = null,
    existingSub = { ...DEFAULT_SUB },
    listRows = [],
  } = opts;

  const createSpy = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "sub-new",
    ...args.data,
  }));
  const updateSpy = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...DEFAULT_SUB,
    id: args.where.id,
    ...args.data,
  }));
  const deleteSpy = vi.fn(async () => existingSub);
  const findUniqueSub = vi.fn(async () => existingSub);
  const findManySub = vi.fn(async () => listRows);

  const prisma = {
    teams: {
      findUnique: vi.fn(async () => ({ organisationId: ORG_ID })),
    },
    teamMembers: {
      findUnique: vi.fn(async () => teamMembership),
    },
    organisationUsers: {
      findUnique: vi.fn(async () => orgMembership),
    },
    webhookSubscription: {
      findUnique: findUniqueSub,
      findMany: findManySub,
      create: createSpy,
      update: updateSpy,
      delete: deleteSpy,
    },
  };

  const ctx = {
    prisma,
    user: caller as Context["user"],
    session: null,
  } as unknown as Context;

  return { ctx, createSpy, updateSpy, deleteSpy, findUniqueSub, findManySub };
}

const createAlertWebhook = webhookResolvers.Mutation.createAlertWebhook;
const updateAlertWebhook = webhookResolvers.Mutation.updateAlertWebhook;
const deleteAlertWebhook = webhookResolvers.Mutation.deleteAlertWebhook;
const rotateAlertWebhookSecret = webhookResolvers.Mutation.rotateAlertWebhookSecret;
const teamAlertWebhooks = webhookResolvers.Query.teamAlertWebhooks;

const CREATE_INPUT = {
  teamId: TEAM_ID,
  name: "Ops hook",
  targetUrl: "https://hooks.test/clear",
  alertTypeFilter: ["FL"],
  minSeverity: 2,
};

// Callers who should pass requireTeamAdminOrOrgAdmin.
const ALLOWED_CALLERS: Array<{ label: string; caller: { id: string; role: string }; opts: Opts }> = [
  { label: "platform admin", caller: { id: "u-admin", role: "admin" }, opts: {} },
  {
    label: "team_admin",
    caller: { id: "u-ta", role: "member" },
    opts: { teamMembership: { role: "team_admin" } },
  },
  {
    label: "org_admin",
    caller: { id: "u-oa", role: "member" },
    opts: { orgMembership: { role: "org_admin" } },
  },
];

describe("createAlertWebhook", () => {
  for (const { label, caller, opts } of ALLOWED_CALLERS) {
    it(`allows ${label} and returns the secret`, async () => {
      const { ctx, createSpy } = buildContext(caller, opts);
      const result = (await createAlertWebhook(undefined, { input: CREATE_INPUT }, ctx)) as {
        secret: string;
      };
      expect(createSpy).toHaveBeenCalledTimes(1);
      const data = createSpy.mock.calls[0]?.[0]?.data as Record<string, unknown>;
      expect(data).toMatchObject({
        source: "clear_alert",
        teamId: TEAM_ID,
        name: "Ops hook",
        alertTypeFilter: ["FL"],
        minSeverity: 2,
        createdBy: caller.id,
      });
      // 32 random bytes hex-encoded = 64 chars, returned on create.
      expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("FORBIDDEN for a plain team member", async () => {
    const { ctx, createSpy } = buildContext(
      { id: "u-member", role: "member" },
      { teamMembership: { role: "team_member" } },
    );
    await expect(
      createAlertWebhook(undefined, { input: CREATE_INPUT }, ctx),
    ).rejects.toThrow(/team admin or org admin/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("FORBIDDEN for a non-member", async () => {
    const { ctx, createSpy } = buildContext({ id: "u-nobody", role: "member" }, {});
    await expect(
      createAlertWebhook(undefined, { input: CREATE_INPUT }, ctx),
    ).rejects.toThrow(/team admin or org admin/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-https targetUrl", async () => {
    const { ctx, createSpy } = buildContext({ id: "u-admin", role: "admin" }, {});
    await expect(
      createAlertWebhook(
        undefined,
        { input: { ...CREATE_INPUT, targetUrl: "http://evil.test/hook" } },
        ctx,
      ),
    ).rejects.toThrow(/https/i);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("updateAlertWebhook", () => {
  it("allows a team_admin and scrubs the secret from the response", async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-ta", role: "member" },
      { teamMembership: { role: "team_admin" } },
    );
    const result = (await updateAlertWebhook(
      undefined,
      { id: "sub-1", input: { name: "renamed", minSeverity: 4 } },
      ctx,
    )) as { secret: string | null };
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]?.[0]?.data).toMatchObject({ name: "renamed", minSeverity: 4 });
    expect(result.secret).toBeNull();
  });

  it("FORBIDDEN for a plain member", async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-member", role: "member" },
      { teamMembership: { role: "analyst" } },
    );
    await expect(
      updateAlertWebhook(undefined, { id: "sub-1", input: { name: "x" } }, ctx),
    ).rejects.toThrow(/team admin or org admin/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("NOT_FOUND when the id is a glitchtip subscription", async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-admin", role: "admin" },
      { existingSub: { ...DEFAULT_SUB, source: "glitchtip", teamId: null } },
    );
    await expect(
      updateAlertWebhook(undefined, { id: "sub-1", input: { name: "x" } }, ctx),
    ).rejects.toThrow(/not found/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("deleteAlertWebhook", () => {
  it("allows an org_admin", async () => {
    const { ctx, deleteSpy } = buildContext(
      { id: "u-oa", role: "member" },
      { orgMembership: { role: "org_admin" } },
    );
    await expect(deleteAlertWebhook(undefined, { id: "sub-1" }, ctx)).resolves.toBe(true);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("NOT_FOUND for a glitchtip id (never deletes a glitchtip row)", async () => {
    const { ctx, deleteSpy } = buildContext(
      { id: "u-admin", role: "admin" },
      { existingSub: { ...DEFAULT_SUB, source: "glitchtip", teamId: null } },
    );
    await expect(deleteAlertWebhook(undefined, { id: "sub-1" }, ctx)).rejects.toThrow(/not found/i);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("NOT_FOUND when the subscription is missing", async () => {
    const { ctx, deleteSpy } = buildContext(
      { id: "u-admin", role: "admin" },
      { existingSub: null },
    );
    await expect(deleteAlertWebhook(undefined, { id: "gone" }, ctx)).rejects.toThrow(/not found/i);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("rotateAlertWebhookSecret", () => {
  it("allows a team_admin and returns the new secret", async () => {
    const { ctx, updateSpy } = buildContext(
      { id: "u-ta", role: "member" },
      { teamMembership: { role: "team_admin" } },
    );
    const result = (await rotateAlertWebhookSecret(undefined, { id: "sub-1" }, ctx)) as {
      secret: string;
    };
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const data = updateSpy.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FORBIDDEN for a non-member", async () => {
    const { ctx, updateSpy } = buildContext({ id: "u-nobody", role: "member" }, {});
    await expect(rotateAlertWebhookSecret(undefined, { id: "sub-1" }, ctx)).rejects.toThrow(
      /team admin or org admin/i,
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("teamAlertWebhooks", () => {
  it("lists a team's clear_alert subscriptions with secrets scrubbed", async () => {
    const { ctx, findManySub } = buildContext(
      { id: "u-ta", role: "member" },
      {
        teamMembership: { role: "team_admin" },
        listRows: [
          { ...DEFAULT_SUB, id: "sub-1", secret: "s1" },
          { ...DEFAULT_SUB, id: "sub-2", secret: "s2" },
        ],
      },
    );
    const rows = (await teamAlertWebhooks(undefined, { teamId: TEAM_ID }, ctx)) as Array<{
      id: string;
      secret: string | null;
    }>;
    expect(findManySub).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: "clear_alert", teamId: TEAM_ID } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.secret === null)).toBe(true);
  });

  it("FORBIDDEN for a plain member", async () => {
    const { ctx, findManySub } = buildContext(
      { id: "u-member", role: "member" },
      { teamMembership: { role: "team_member" } },
    );
    await expect(teamAlertWebhooks(undefined, { teamId: TEAM_ID }, ctx)).rejects.toThrow(
      /team admin or org admin/i,
    );
    expect(findManySub).not.toHaveBeenCalled();
  });
});
