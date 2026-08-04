/**
 * Unit tests for the shared password-reset service.
 *
 * DB-free: `prisma` is stubbed per-test, the messaging module is mocked so
 * no real mail is sent, and Better Auth's hasher is mocked so the suite
 * doesn't pay for a real KDF on every case.
 *
 * The behaviour that matters most here is what the flow *refuses* to
 * reveal — `sendPasswordResetEmail` must be externally indistinguishable
 * across "unknown address", "throttled" and "mail provider exploded".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("../../src/services/messaging/index.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send: sendMock })),
  templates: {
    passwordReset: (name: string, url: string) => ({
      subject: "reset",
      textBody: `t ${name} ${url}`,
      htmlBody: "<p>",
    }),
  },
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
}));

import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_IDENTIFIER_PREFIX,
  RESET_THROTTLE_MS,
  buildResetUrl,
  findValidResetToken,
  issueResetToken,
  resetPasswordWithToken,
  sendPasswordResetEmail,
} from "../../src/services/password-reset.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

type PrismaStub = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const asPrisma = (stub: PrismaStub) => stub as unknown as PrismaClient;

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

describe("buildResetUrl", () => {
  it("points at the portal reset page on this API host, not the frontend", () => {
    const url = buildResetUrl("abc123");
    expect(url).toContain("/portal/reset-password?token=abc123");
    expect(url).not.toContain("/auth/reset-password");
  });

  it("appends kind=setup for the dev-user welcome link", () => {
    expect(buildResetUrl("abc123", "setup")).toContain("&kind=setup");
  });

  it("does not double up the slash when the base URL has a trailing one", () => {
    expect(buildResetUrl("t")).not.toContain("//portal");
  });
});

describe("issueResetToken", () => {
  it("clears outstanding tokens for the email before minting a new one", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const create = vi.fn().mockResolvedValue({ id: "v1" });
    const prisma = asPrisma({ verification: { deleteMany, create } });

    const token = await issueResetToken(prisma, "a@b.dev");

    expect(deleteMany).toHaveBeenCalledWith({
      where: { identifier: `${PASSWORD_RESET_IDENTIFIER_PREFIX}a@b.dev` },
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(create.mock.calls[0][0].data.value).toBe(token);
  });

  it("honours a custom TTL (the 7-day welcome link)", async () => {
    const create = vi.fn().mockResolvedValue({ id: "v1" });
    const prisma = asPrisma({
      verification: { deleteMany: vi.fn(), create },
    });
    const ttl = 7 * 24 * 60 * 60 * 1000;

    const before = Date.now();
    await issueResetToken(prisma, "a@b.dev", ttl);
    const expiresAt: Date = create.mock.calls[0][0].data.expiresAt;

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttl);
    expect(expiresAt.getTime()).toBeLessThan(before + ttl + 5_000);
  });
});

describe("sendPasswordResetEmail", () => {
  it("is a silent no-op for an unknown address (no enumeration)", async () => {
    const create = vi.fn();
    const prisma = asPrisma({
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      verification: { create },
    });

    await expect(sendPasswordResetEmail(prisma, "ghost@b.dev")).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("stays silent when throttled, without minting a replacement token", async () => {
    const create = vi.fn();
    const deleteMany = vi.fn();
    const prisma = asPrisma({
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date() }),
        create,
        deleteMany,
      },
    });

    await sendPasswordResetEmail(prisma, "a@b.dev");

    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends again once the throttle window has elapsed", async () => {
    const prisma = asPrisma({
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue({
          createdAt: new Date(Date.now() - RESET_THROTTLE_MS - 1_000),
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "v2" }),
      },
    });

    await sendPasswordResetEmail(prisma, "a@b.dev");

    expect(sendMock).toHaveBeenCalledOnce();
  });

  it("mints a token and mails a portal link on the happy path", async () => {
    const create = vi.fn().mockResolvedValue({ id: "v1" });
    const prisma = asPrisma({
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create,
      },
    });

    await sendPasswordResetEmail(prisma, "a@b.dev");

    expect(create.mock.calls[0][0].data.identifier).toBe("password-reset:a@b.dev");
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe("a@b.dev");
    expect(sendMock.mock.calls[0][0].textBody).toContain("/portal/reset-password?token=");
  });

  it("swallows a mail-provider failure so the caller can't tell", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const prisma = asPrisma({
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: "v1" }),
      },
    });

    await expect(sendPasswordResetEmail(prisma, "a@b.dev")).resolves.toBeUndefined();
  });
});

describe("findValidResetToken", () => {
  it("returns null for an empty token without querying", async () => {
    const findFirst = vi.fn();
    const prisma = asPrisma({ verification: { findFirst } });

    await expect(findValidResetToken(prisma, "")).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns null when the token is unknown or expired", async () => {
    const prisma = asPrisma({
      verification: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    await expect(findValidResetToken(prisma, "bad")).resolves.toBeNull();
  });

  it("extracts the email from the identifier and leaves the token intact", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValue({ id: "v1", identifier: "password-reset:a@b.dev" });
    const del = vi.fn();
    const prisma = asPrisma({ verification: { findFirst, delete: del } });

    await expect(findValidResetToken(prisma, "tok")).resolves.toEqual({
      id: "v1",
      email: "a@b.dev",
    });
    // Peeking must not consume — the form still has to be submitted.
    expect(del).not.toHaveBeenCalled();
  });
});

describe("resetPasswordWithToken", () => {
  function buildPrisma(overrides: PrismaStub = {}): PrismaStub {
    return {
      verification: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "v1", identifier: "password-reset:a@b.dev" }),
        delete: vi.fn().mockResolvedValue({ id: "v1" }),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      account: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      ...overrides,
    };
  }

  it("rejects a password below the minimum length", async () => {
    await expect(
      resetPasswordWithToken(asPrisma(buildPrisma()), "tok", "x".repeat(MIN_PASSWORD_LENGTH - 1)),
    ).resolves.toEqual({ ok: false, reason: "WEAK_PASSWORD" });
  });

  it("rejects an unknown or expired token", async () => {
    const prisma = buildPrisma({
      verification: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      resetPasswordWithToken(asPrisma(prisma), "bad", "longenough"),
    ).resolves.toEqual({ ok: false, reason: "INVALID_TOKEN" });
  });

  it("reports USER_NOT_FOUND when the token outlived its user", async () => {
    const prisma = buildPrisma({
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      resetPasswordWithToken(asPrisma(prisma), "tok", "longenough"),
    ).resolves.toEqual({ ok: false, reason: "USER_NOT_FOUND" });
  });

  it("writes the hash, consumes the token and revokes every session", async () => {
    const prisma = buildPrisma();

    await expect(
      resetPasswordWithToken(asPrisma(prisma), "tok", "longenough"),
    ).resolves.toEqual({ ok: true });

    expect(prisma.account.updateMany.mock.calls[0][0]).toEqual({
      where: { userId: "u1", providerId: "credential" },
      data: { password: "hashed:longenough" },
    });
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.verification.delete).toHaveBeenCalledWith({ where: { id: "v1" } });
    // A reset is the remedy for a compromise — stale sessions must die.
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("creates the credential account when the user has none yet (dev-user setup link)", async () => {
    const prisma = buildPrisma({
      account: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
    });

    await expect(
      resetPasswordWithToken(asPrisma(prisma), "tok", "longenough"),
    ).resolves.toEqual({ ok: true });

    expect(prisma.account.create).toHaveBeenCalledOnce();
    expect(prisma.account.create.mock.calls[0][0].data).toMatchObject({
      userId: "u1",
      providerId: "credential",
      password: "hashed:longenough",
    });
  });

  it("still succeeds when session revocation fails", async () => {
    const prisma = buildPrisma({
      session: { deleteMany: vi.fn().mockRejectedValue(new Error("db blip")) },
    });

    await expect(
      resetPasswordWithToken(asPrisma(prisma), "tok", "longenough"),
    ).resolves.toEqual({ ok: true });
  });
});
