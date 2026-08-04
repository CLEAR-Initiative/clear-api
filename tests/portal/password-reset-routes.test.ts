/**
 * Handler tests for the Developer Portal's forgot/reset-password routes.
 *
 * The portal router is mounted on a throwaway Express server and driven
 * over HTTP with `fetch`, so status codes and response bodies are asserted
 * exactly as the login page's client-side JS sees them. DB-free: the
 * password-reset service, Prisma and Better Auth are all mocked.
 *
 * The recurring theme is that these endpoints must not leak: a wrong
 * address, a throttled address and a dead mail provider all have to come
 * back looking the same.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const {
  sendPasswordResetEmailMock,
  findValidResetTokenMock,
  resetPasswordWithTokenMock,
} = vi.hoisted(() => ({
  sendPasswordResetEmailMock: vi.fn(),
  findValidResetTokenMock: vi.fn(),
  resetPasswordWithTokenMock: vi.fn(),
}));

vi.mock("../../src/services/password-reset.js", () => ({
  MIN_PASSWORD_LENGTH: 8,
  sendPasswordResetEmail: sendPasswordResetEmailMock,
  findValidResetToken: findValidResetTokenMock,
  resetPasswordWithToken: resetPasswordWithTokenMock,
  buildResetUrl: vi.fn(),
  issueResetToken: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));

vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
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
  sendPasswordResetEmailMock.mockReset().mockResolvedValue(undefined);
  findValidResetTokenMock.mockReset();
  resetPasswordWithTokenMock.mockReset();
});

function postJson(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /portal/forgot-password", () => {
  it("returns 204 and dispatches for a well-formed address", async () => {
    const res = await postJson("/portal/forgot-password", { email: "a@b.dev" });

    expect(res.status).toBe(204);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledOnce();
    expect(sendPasswordResetEmailMock.mock.calls[0][1]).toBe("a@b.dev");
  });

  it("normalises the address so casing and padding don't fork the throttle", async () => {
    await postJson("/portal/forgot-password", { email: "  A@B.Dev  " });

    expect(sendPasswordResetEmailMock.mock.calls[0][1]).toBe("a@b.dev");
  });

  it("returns the same 204 when the service reports nothing happened", async () => {
    // Unknown address / throttled — the service resolves either way.
    const res = await postJson("/portal/forgot-password", { email: "ghost@b.dev" });

    expect(res.status).toBe(204);
  });

  it("still returns 204 when the service throws outright", async () => {
    sendPasswordResetEmailMock.mockRejectedValue(new Error("db down"));

    const res = await postJson("/portal/forgot-password", { email: "a@b.dev" });

    expect(res.status).toBe(204);
  });

  it("returns 204 without dispatching when the email is missing or not a string", async () => {
    expect((await postJson("/portal/forgot-password", {})).status).toBe(204);
    expect((await postJson("/portal/forgot-password", { email: 42 })).status).toBe(204);
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
  });
});

describe("GET /portal/reset-password", () => {
  it("renders the form for a live token", async () => {
    findValidResetTokenMock.mockResolvedValue({ id: "v1", email: "a@b.dev" });

    const res = await fetch(`${base}/portal/reset-password?token=tok`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("Set a New Password");
    expect(html).toContain('id="password"');
  });

  it("uses first-time wording for the dev-user setup link", async () => {
    findValidResetTokenMock.mockResolvedValue({ id: "v1", email: "a@b.dev" });

    const html = await (
      await fetch(`${base}/portal/reset-password?token=tok&kind=setup`)
    ).text();

    expect(html).toContain("Choose a Password");
    expect(html).toContain("Welcome to CLEAR");
  });

  it("shows a dead-link message instead of a form for an expired token", async () => {
    findValidResetTokenMock.mockResolvedValue(null);

    const res = await fetch(`${base}/portal/reset-password?token=stale`);
    const html = await res.text();

    expect(res.status).toBe(400);
    expect(html).toContain("Link Expired");
    expect(html).not.toContain('id="password"');
  });

  it("shows the dead-link page without querying when no token is supplied", async () => {
    const res = await fetch(`${base}/portal/reset-password`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Link Expired");
    expect(findValidResetTokenMock).not.toHaveBeenCalled();
  });

  // Regression: the token used to be interpolated into a <script> block via
  // JSON.stringify, which does not escape "/". A token containing a closing
  // script tag terminated the block early and the remainder was parsed as
  // attacker-controlled HTML — reflected XSS on the origin that holds the
  // portal session cookie, reachable without a valid token.
  it.each([
    ['closing script tag', '</script><img src=x onerror=alert(1)>'],
    ['attribute breakout', '"><script>alert(1)</script>'],
    ['quote and semicolon', '";alert(1);//'],
  ])("does not let a %s in the token escape into executable markup", async (_label, payload) => {
    findValidResetTokenMock.mockResolvedValue({ id: "v1", email: "a@b.dev" });

    const html = await (
      await fetch(`${base}/portal/reset-password?token=${encodeURIComponent(payload)}`)
    ).text();

    // The page has exactly one script element; a breakout would add more.
    expect(html.split("<script>").length - 1).toBe(1);
    expect(html.split("</script>").length - 1).toBe(1);
    // And the raw payload never appears unescaped anywhere in the document.
    expect(html).not.toContain(payload);
  });

  it("keeps the token out of script context even on the expired-link page", async () => {
    findValidResetTokenMock.mockResolvedValue(null);
    const payload = "</script><img src=x onerror=alert(1)>";

    const html = await (
      await fetch(`${base}/portal/reset-password?token=${encodeURIComponent(payload)}`)
    ).text();

    expect(html.split("</script>").length - 1).toBe(1);
    expect(html).not.toContain(payload);
  });
});

describe("POST /portal/reset-password", () => {
  it("returns 204 on success", async () => {
    resetPasswordWithTokenMock.mockResolvedValue({ ok: true });

    const res = await postJson("/portal/reset-password", {
      token: "tok",
      newPassword: "longenough",
    });

    expect(res.status).toBe(204);
    expect(resetPasswordWithTokenMock).toHaveBeenCalledWith({}, "tok", "longenough");
  });

  it("returns 400 with a length hint for a weak password", async () => {
    resetPasswordWithTokenMock.mockResolvedValue({
      ok: false,
      reason: "WEAK_PASSWORD",
    });

    const res = await postJson("/portal/reset-password", {
      token: "tok",
      newPassword: "short",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("at least 8 characters");
  });

  it("gives an invalid token and an orphaned one the same 400 message", async () => {
    resetPasswordWithTokenMock.mockResolvedValue({
      ok: false,
      reason: "INVALID_TOKEN",
    });
    const invalid = await (
      await postJson("/portal/reset-password", { token: "bad", newPassword: "longenough" })
    ).json();

    resetPasswordWithTokenMock.mockResolvedValue({
      ok: false,
      reason: "USER_NOT_FOUND",
    });
    const orphaned = await (
      await postJson("/portal/reset-password", { token: "tok", newPassword: "longenough" })
    ).json();

    expect(invalid.message).toBe(orphaned.message);
    expect(invalid.message).toContain("invalid or has expired");
  });

  it("returns 500 without leaking the error when the service throws", async () => {
    resetPasswordWithTokenMock.mockRejectedValue(new Error("db exploded"));

    const res = await postJson("/portal/reset-password", {
      token: "tok",
      newPassword: "longenough",
    });

    expect(res.status).toBe(500);
    expect((await res.json()).message).not.toContain("db exploded");
  });

  it("coerces missing fields to empty strings rather than crashing", async () => {
    resetPasswordWithTokenMock.mockResolvedValue({
      ok: false,
      reason: "WEAK_PASSWORD",
    });

    const res = await postJson("/portal/reset-password", {});

    expect(res.status).toBe(400);
    expect(resetPasswordWithTokenMock).toHaveBeenCalledWith({}, "", "");
  });
});

describe("login page", () => {
  it("offers a forgot-password entry point", async () => {
    const html = await (await fetch(`${base}/portal/login`)).text();

    expect(html).toContain("Forgot your password?");
    expect(html).toContain("/portal/forgot-password");
  });

  it("keeps the forgot panel hidden until it's asked for", async () => {
    const html = await (await fetch(`${base}/portal/login`)).text();

    // Register is the default panel; sign-in and forgot start collapsed.
    expect(html).toContain('<div id="forgot-form" style="display:none">');
  });
});
