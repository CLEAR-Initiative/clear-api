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
import { runInNewContext } from "node:vm";
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

/** Simulates the DB: a user row plus an optional saved profile and keys. */
let savedProfile: Record<string, string | null> | null;
let savedKeys: { lastUsedAt: Date | null }[];

beforeEach(() => {
  savedProfile = null;
  savedKeys = [];
  getSessionMock.mockReset().mockResolvedValue({ user: pendingUser });
  userFindUnique.mockReset().mockImplementation(async () => ({
    name: "Ada",
    developerProfile: savedProfile,
    apiKeys: savedKeys,
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
  it("renders for a pending user, who is sent on to Welcome unless the hash is a docs tab", async () => {
    const res = await fetch(`${base}/portal`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<script>if (["getting-started","reference","authentication"].indexOf(location.hash.slice(1)) === -1) location.replace('/portal/welcome');</script>`,
    );
    expect(html).toContain('var PORTAL_PENDING_TABS = ["getting-started","reference","authentication"];');
  });

  it("runs the pending redirect: docs tabs stay, a bare /portal or a locked tab goes to Welcome", async () => {
    const html = await (await fetch(`${base}/portal`)).text();
    const script = html.match(/<script>(if \(\[[^<]*location\.replace[^<]*)<\/script>/)![1]!;
    const landing = (hash: string) => {
      let target: string | null = null;
      runInNewContext(script, { location: { hash, replace: (url: string) => (target = url) } });
      return target;
    };
    for (const hash of ["#getting-started", "#reference", "#authentication"]) {
      expect(landing(hash)).toBeNull();
    }
    for (const hash of ["", "#api-keys", "#usage-analytics", "#nope"]) {
      expect(landing(hash)).toBe("/portal/welcome");
    }
  });

  it("still renders the portal for approved users", async () => {
    getSessionMock.mockResolvedValue({ user: { ...pendingUser, role: "member" } });
    const res = await fetch(`${base}/portal`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/portal/welcome"');
    expect(html).not.toContain("location.replace('/portal/welcome')");
    expect(html).toContain("var PORTAL_PENDING_TABS = null;");
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

  it("shows a new sign-up their progress, with the profile as the next step", async () => {
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).toContain("Next: tell us about yourself");
    expect(html).toContain("1 of 5 done");
    expect(html).toMatch(/data-step="profile" aria-current="step"/);
    expect(html).toMatch(/class="welcome-step welcome-step--locked" data-step="approval"/);
    expect(html).toContain('id="about-you"');
  });

  it("tells a pending developer with a profile that it's over to us", async () => {
    savedProfile = { organisation: "NRC" };
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).toContain("Over to us: we&#39;re reviewing your account");
    expect(html).toMatch(/class="welcome-step welcome-step--waiting" data-step="approval"/);
    expect(html).not.toContain('aria-current="step"');
  });

  it("moves an approved developer on to their first request once they have a key", async () => {
    getSessionMock.mockResolvedValue({ user: { ...pendingUser, role: "member" } });
    savedProfile = { organisation: "NRC" };
    savedKeys = [{ lastUsedAt: null }];
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).toContain("4 of 5 done");
    expect(html).toMatch(/data-step="firstRequest" aria-current="step"/);

    savedKeys = [{ lastUsedAt: new Date() }];
    const done = await (await fetch(`${base}/portal/welcome`)).text();
    expect(done).toContain("You&#39;re all set");
    expect(done).toContain("5 of 5 done");
  });

  it("gives a new sign-up things to do while they wait, after the form", async () => {
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).toContain("While you wait");
    expect(html).toContain("CONTRIBUTING.md#explore-on-your-own-no-account-needed");
    expect(html).toContain('href="/portal#reference"');
    for (const repo of ["clear-api", "clear-pipeline", "clear-mvp"]) {
      expect(html).toContain(`href="https://github.com/CLEAR-Initiative/${repo}"`);
    }
    expect(html.indexOf('id="about-you"')).toBeLessThan(html.indexOf("While you wait"));
  });

  it("moves the waiting panel above the form once the profile is saved", async () => {
    savedProfile = { organisation: "NRC" };
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html.indexOf("While you wait")).toBeLessThan(html.indexOf('id="about-you"'));
  });

  it("drops the waiting panel once approved", async () => {
    getSessionMock.mockResolvedValue({ user: { ...pendingUser, role: "member" } });
    const html = await (await fetch(`${base}/portal/welcome`)).text();
    expect(html).not.toContain("While you wait");
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
