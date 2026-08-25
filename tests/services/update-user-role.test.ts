/**
 * DB-free unit tests for `updateUserGlobalRole`. Prisma delegates are
 * stubbed so CI can run without a database. The load-bearing contract
 * is the guard set shared by GraphQL `updateUserRole` and the portal
 * HTML POST: pending users, self-demote, last admin, invalid role.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";
import {
  isGlobalRole,
  updateUserGlobalRole,
} from "../../src/services/update-user-role.js";

const { logActivityMock } = vi.hoisted(() => ({
  logActivityMock: vi.fn(async () => undefined),
}));

vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

type UserRow = {
  id: string;
  email: string;
  role: string | null;
};

function buildPrisma(opts: {
  target?: UserRow | null;
  adminCount?: number;
  update?: ReturnType<typeof vi.fn>;
}) {
  const update = opts.update ?? vi.fn(async ({ data }: { data: { role: string } }) => ({
    ...opts.target,
    role: data.role,
  }));
  return {
    prisma: {
      user: {
        findUnique: vi.fn().mockResolvedValue(opts.target ?? null),
        update,
        count: vi.fn().mockResolvedValue(opts.adminCount ?? 2),
      },
    },
    update,
  };
}

const viewer: UserRow = { id: "u1", email: "ok@example.com", role: "viewer" };
const admin: UserRow = { id: "admin-1", email: "admin@clear.dev", role: "admin" };

beforeEach(() => {
  logActivityMock.mockClear();
});

describe("isGlobalRole", () => {
  it("accepts viewer, analyst, and admin only", () => {
    expect(isGlobalRole("admin")).toBe(true);
    expect(isGlobalRole("pending")).toBe(false);
    expect(isGlobalRole("org_admin")).toBe(false);
  });
});

describe("updateUserGlobalRole", () => {
  it("updates the role and writes an audit row", async () => {
    const { prisma, update } = buildPrisma({ target: viewer });
    const result = await updateUserGlobalRole(
      prisma as never,
      "admin-1",
      "u1",
      "analyst",
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { role: "analyst" },
    });
    expect(result.role).toBe("analyst");
    expect(logActivityMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        userId: "admin-1",
        action: "user.role_updated",
        resourceId: "u1",
        metadata: { email: "ok@example.com", from: "viewer", to: "analyst" },
      }),
    );
  });

  it("is a no-op when the stored role already matches", async () => {
    const { prisma, update } = buildPrisma({ target: viewer });
    await updateUserGlobalRole(prisma as never, "admin-1", "u1", "viewer");
    expect(update).not.toHaveBeenCalled();
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid role without touching the DB", async () => {
    const { prisma, update } = buildPrisma({ target: viewer });
    await expect(
      updateUserGlobalRole(prisma as never, "admin-1", "u1", "owner"),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid role/),
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses to let an admin demote themselves", async () => {
    const { prisma, update } = buildPrisma({ target: admin });
    await expect(
      updateUserGlobalRole(prisma as never, "admin-1", "admin-1", "viewer"),
    ).rejects.toThrow(/cannot change your own role/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows an admin to keep their own admin role", async () => {
    const { prisma, update } = buildPrisma({ target: admin });
    await updateUserGlobalRole(prisma as never, "admin-1", "admin-1", "admin");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses pending users (approve first)", async () => {
    const { prisma, update } = buildPrisma({
      target: { id: "p1", email: "p@x.com", role: "pending" },
    });
    await expect(
      updateUserGlobalRole(prisma as never, "admin-1", "p1", "viewer"),
    ).rejects.toThrow(/Approve pending users first/);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses to demote the last admin", async () => {
    const { prisma, update } = buildPrisma({ target: admin, adminCount: 1 });
    await expect(
      updateUserGlobalRole(prisma as never, "other-admin", "admin-1", "viewer"),
    ).rejects.toThrow(/last admin/);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows demoting an admin when another remains", async () => {
    const { prisma, update } = buildPrisma({ target: admin, adminCount: 2 });
    await updateUserGlobalRole(prisma as never, "other-admin", "admin-1", "viewer");
    expect(update).toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a missing user", async () => {
    const { prisma } = buildPrisma({ target: null });
    await expect(
      updateUserGlobalRole(prisma as never, "admin-1", "missing", "viewer"),
    ).rejects.toBeInstanceOf(GraphQLError);
    await expect(
      updateUserGlobalRole(prisma as never, "admin-1", "missing", "viewer"),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
