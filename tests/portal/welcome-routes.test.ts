/**
 * HTTP seam for the post-signup Welcome page (`/portal/welcome`): who gets
 * sent there, who gets bounced to sign-in, form validation and escaping,
 * and the once-only maintainer notification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

const {
  getSessionMock,
  userFindUnique,
  userUpdate,
  profileFindUnique,
  profileCreate,
  profileUpdate,
  notifyProfileMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  profileFindUnique: vi.fn(),
  profileCreate: vi.fn(),
  profileUpdate: vi.fn(),
  notifyProfileMock: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
    developerProfile: {
      findUnique: profileFindUnique,
      create: profileCreate,
      update: profileUpdate,
    },
  },
}));

vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("../../src/services/signup-notify.js", () => ({
  notifyMaintainersOfProfile: notifyProfileMock,
}));

vi.mock("../../src/services/password-reset.js", () => ({
  MIN_PASSWORD_LENGTH: 8,
  sendPasswordResetEmail: vi.fn(),
  findValidResetToken: vi.fn(),
  resetPasswordWithToken: vi.fn(),
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

const pendingUser = { id: "u-1", email: "ada@example.org", role: "pending", name: "Ada" };

/** Simulates the DB: a user row plus an optional saved profile. */
let savedProfile: Record<string, string | null> | null;

beforeEach(() => {
  savedProfile = null;
  getSessionMock.mockReset().mockResolvedValue({ user: pendingUser });
  userFindUnique.mockReset().mockImplementation(async () => ({
    name: "Ada",
    developerProfile: savedProfile,
  }));
  userUpdate.mockReset().mockResolvedValue({});
  profileFindUnique.mockReset().mockImplementation(async () => (savedProfile ? { id: "p1" } : null));
  profileCreate.mockReset().mockImplementation(async ({ data }) => {
    const { userId: _userId, ...rest } = data;
    savedProfile = rest;
    return { id: "p1" };
  });
  profileUpdate.mockReset().mockImplementation(async ({ data }) => {
    savedProfile = { ...savedProfile, ...data };
    return { id: "p1" };
  });
  notifyProfileMock.mockReset().mockResolvedValue(undefined);
});

function post(body: Record<string, string>) {
  return fetch(`${base}/portal/welcome`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
}

describe("GET /portal", () => {
  it("sends a pending user to the Welcome page", async () => {
    const res = await fetch(`${base}/portal`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal/welcome");
  });

  it("still renders the portal for approved users", async () => {
    getSessionMock.mockResolvedValue({ user: { ...pendingUser, role: "member" } });
    const res = await fetch(`${base}/portal`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/portal/welcome"');
  });
});

describe("GET /portal/welcome", () => {
  it("sends anonymous visitors to sign-in and back", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await fetch(`${base}/portal/welcome`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/portal/login?next=%2Fportal%2Fwelcome");
  });

  it("renders the Welcome page in the portal shell, prefilled from the account", async () => {
    const res = await fetch(`${base}/portal/welcome`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Welcome to CLEAR, Ada.");
    expect(html).toContain("automatically requested API key access");
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('<a href="/portal/welcome" class="nav-item nav-item--link active"');
    expect(html).toMatch(/name="name"[^>]*value="Ada"/);
    expect(html).toContain('action="/portal/welcome"');
    expect(html).toContain("Save details");
  });

  it("shows saved values for editing once the profile exists", async () => {
    savedProfile = {
      personalWebsite: null,
      organisation: "NRC",
      organisationWebsite: "https://www.nrc.no/",
      linkedinUrl: null,
      githubUrl: "https://github.com/ada",
      contributionInterest: "Data pipeline",
    };
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).toMatch(/name="organisation"[^>]*value="NRC"/);
    expect(html).toMatch(/name="githubUrl"[^>]*value="https:\/\/github.com\/ada"/);
    expect(html).toContain(">Data pipeline</textarea>");
    expect(html).toContain("Save changes");
  });

  it("shows the success toast after a save", async () => {
    const html = await (
      await fetch(`${base}/portal/welcome?flash=success&msg=Saved`)
    ).text();
    expect(html).toContain("portal-toast--success");
  });
});

describe("POST /portal/welcome", () => {
  it("bounces anonymous posts to sign-in without saving", async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await post({ name: "Ada" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/portal/login");
    expect(profileCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) URL and saves nothing", async () => {
    const res = await post({ name: "Ada", githubUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Only http:// and https:// links are accepted.");
    expect(html).toMatch(/name="githubUrl"[^>]*aria-invalid="true"/);
    expect(profileCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(notifyProfileMock).not.toHaveBeenCalled();
  });

  it("re-renders a rejected submission escaped", async () => {
    const payload = `"><script>alert(1)</script>`;
    const res = await post({ name: payload, organisation: payload, githubUrl: "nope" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("saves, redirects with a success toast, and renders saved XSS escaped", async () => {
    const payload = `<img src=x onerror=alert(1)>`;
    const res = await post({
      name: "  Ada Lovelace ",
      organisation: payload,
      contributionInterest: `</textarea>${payload}`,
      githubUrl: "github.com/ada",
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/portal\/welcome\?flash=success&msg=/);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Ada Lovelace" }) }),
    );
    expect(savedProfile).toMatchObject({ githubUrl: "https://github.com/ada", organisation: payload });

    const html = await (await fetch(`${base}${location}`)).text();
    expect(html).not.toContain(payload);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("</textarea><img");
  });

  it("notifies maintainers on the first submit only", async () => {
    await post({ name: "Ada", organisation: "NRC" });
    expect(notifyProfileMock).toHaveBeenCalledTimes(1);
    expect(notifyProfileMock).toHaveBeenCalledWith(
      { name: "Ada", email: "ada@example.org" },
      expect.objectContaining({ organisation: "NRC" }),
    );

    await post({ name: "Ada", organisation: "NRC Norway" });
    expect(notifyProfileMock).toHaveBeenCalledTimes(1);
    expect(profileUpdate).toHaveBeenCalledTimes(1);
  });

  it("still saves when the notification fails", async () => {
    notifyProfileMock.mockRejectedValue(new Error("smtp down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ name: "Ada" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("flash=success");
  });

  it("lets approved users edit their details too", async () => {
    getSessionMock.mockResolvedValue({ user: { ...pendingUser, role: "member" } });
    const res = await post({ name: "Ada" });
    expect(res.status).toBe(303);
    expect(profileCreate).toHaveBeenCalled();
  });
});
