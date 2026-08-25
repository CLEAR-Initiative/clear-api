/**
 * HTTP seam for the admin org/team role dropdowns.
 *
 * The org-detail page intercepts `form.js-role-form` submit, POSTs
 * `application/x-www-form-urlencoded` with `Accept: application/json`,
 * and only treats `{ ok: true }` as success. If this endpoint returns
 * HTML (login page, 303 redirect, 404), the UI swallows the error as
 * "Could not update role." and the DB never changes — matching the
 * "had to update the role in the database" report.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const {
  getSessionMock,
  portalUpdateOrgMemberRoleMock,
  portalUpdateTeamMemberRoleMock,
  prismaUserFindUnique,
  prismaUserUpdate,
  prismaUserCount,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  portalUpdateOrgMemberRoleMock: vi.fn(),
  portalUpdateTeamMemberRoleMock: vi.fn(),
  prismaUserFindUnique: vi.fn(),
  prismaUserUpdate: vi.fn(),
  prismaUserCount: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: prismaUserFindUnique,
      update: prismaUserUpdate,
      count: prismaUserCount,
    },
    activityLogs: { create: vi.fn().mockResolvedValue({ id: "log" }) },
  },
}));

vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("../../src/portal/admin-orgs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/portal/admin-orgs.js")>();
  return {
    ...actual,
    portalUpdateOrgMemberRole: portalUpdateOrgMemberRoleMock,
    portalUpdateTeamMemberRole: portalUpdateTeamMemberRoleMock,
  };
});

vi.mock("../../src/services/password-reset.js", () => ({
  MIN_PASSWORD_LENGTH: 8,
  sendPasswordResetEmail: vi.fn(),
  findValidResetToken: vi.fn(),
  resetPasswordWithToken: vi.fn(),
  buildResetUrl: vi.fn(),
  issueResetToken: vi.fn(),
}));

import express from "express";
import { portalRouter } from "../../src/portal/index.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/portal", portalRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  getSessionMock.mockReset().mockResolvedValue({
    user: { id: "admin-1", email: "admin@clear.dev", role: "admin", name: "Admin" },
  });
  portalUpdateOrgMemberRoleMock.mockReset().mockResolvedValue({ id: "m1" });
  portalUpdateTeamMemberRoleMock.mockReset().mockResolvedValue({ id: "tm1" });
  prismaUserFindUnique.mockReset();
  prismaUserUpdate.mockReset();
  prismaUserCount.mockReset();
});

function postRole(
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
}

describe("POST /portal/admin/orgs/members/role (org-role dropdown)", () => {
  it("updates the org role and returns JSON when Accept asks for it", async () => {
    const res = await postRole("/portal/admin/orgs/members/role", {
      orgId: "org_1",
      userId: "user_1",
      role: "member",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: "Org role updated.",
    });
    expect(portalUpdateOrgMemberRoleMock).toHaveBeenCalledWith(
      "org_1",
      "user_1",
      "member",
    );
  });

  it("returns JSON 400 (not a 303 HTML redirect) when the update fails", async () => {
    portalUpdateOrgMemberRoleMock.mockRejectedValueOnce(
      new Error("Member not found in this organisation."),
    );

    const res = await postRole("/portal/admin/orgs/members/role", {
      orgId: "org_1",
      userId: "missing",
      role: "org_admin",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      message: "Member not found in this organisation.",
    });
  });

  it("does not follow a login-page HTML response as success", async () => {
    getSessionMock.mockResolvedValueOnce(null);

    const res = await postRole("/portal/admin/orgs/members/role", {
      orgId: "org_1",
      userId: "user_1",
      role: "member",
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/html/);
    await expect(res.json()).rejects.toThrow();
    expect(portalUpdateOrgMemberRoleMock).not.toHaveBeenCalled();
  });
});

describe("POST /portal/admin/orgs/teams/members/role (team-role dropdown)", () => {
  it("updates the team role and returns JSON when Accept asks for it", async () => {
    const res = await postRole("/portal/admin/orgs/teams/members/role", {
      orgId: "org_1",
      teamId: "team_1",
      userId: "user_1",
      teamRole: "field_coordinator",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: "Team role updated.",
    });
    expect(portalUpdateTeamMemberRoleMock).toHaveBeenCalledWith(
      "org_1",
      "team_1",
      "user_1",
      "field_coordinator",
    );
  });
});

describe("POST /portal/admin/users/role (global role dropdown)", () => {
  it("updates user.role and returns JSON when Accept asks for it", async () => {
    prismaUserFindUnique.mockResolvedValue({
      id: "user_1",
      email: "ok@example.com",
      role: "viewer",
    });
    prismaUserUpdate.mockResolvedValue({
      id: "user_1",
      email: "ok@example.com",
      role: "admin",
    });

    const res = await postRole("/portal/admin/users/role", {
      userId: "user_1",
      role: "admin",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: "ok@example.com: role updated to admin.",
    });
    expect(prismaUserUpdate).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { role: "admin" },
    });
  });

  it("refuses to let an admin demote themselves", async () => {
    const res = await postRole("/portal/admin/users/role", {
      userId: "admin-1",
      role: "viewer",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      message: "You cannot change your own role.",
    });
    expect(prismaUserUpdate).not.toHaveBeenCalled();
  });

  it("refuses to demote the last admin", async () => {
    prismaUserFindUnique.mockResolvedValue({
      id: "other-admin",
      email: "other@example.com",
      role: "admin",
    });
    prismaUserCount.mockResolvedValue(1);

    const res = await postRole("/portal/admin/users/role", {
      userId: "other-admin",
      role: "viewer",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      message: "Cannot demote the last admin.",
    });
    expect(prismaUserUpdate).not.toHaveBeenCalled();
  });
});
