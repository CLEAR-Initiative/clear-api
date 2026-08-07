/**
 * Unit tests for `auth.resolver.ts` (the GraphQL auth mutations layered on top
 * of Better Auth — email verification + password reset).
 *
 * DB-free: `context.prisma` is stubbed per-test and the messaging module is
 * mocked so no real email is sent. Covers the `me` query, the verification
 * throttle / already-verified branches, token validity checks, and the
 * email-enumeration-safe password-reset flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the messaging module BEFORE importing the resolver: getEmailProvider
// returns a provider whose send() we can assert on; templates return a minimal
// {subject, textBody, htmlBody}.
const sendMock = vi.fn();
vi.mock("../../src/services/messaging/index.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send: sendMock })),
  templates: {
    emailVerification: () => ({ subject: "verify", textBody: "t", htmlBody: "<p>" }),
    passwordReset: () => ({ subject: "reset", textBody: "t", htmlBody: "<p>" }),
  },
}));

import { authResolvers } from "../../src/resolvers/auth.resolver.js";
import type { Context } from "../../src/context.js";

type PrismaStub = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function buildContext(user: unknown, prisma: PrismaStub = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const { me } = authResolvers.Query;
const { requestEmailVerification, verifyEmail, requestPasswordReset, resetPassword } =
  authResolvers.Mutation;

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

describe("Query.me", () => {
  it("returns null when unauthenticated", () => {
    expect(me(null, {}, buildContext(null))).toBeNull();
  });
  it("returns the user when authenticated", () => {
    const user = { id: "u1", role: "viewer" };
    expect(me(null, {}, buildContext(user))).toBe(user);
  });
});

describe("Mutation.requestEmailVerification", () => {
  const baseUser = {
    id: "u1",
    email: "a@b.dev",
    name: "A",
    emailVerified: false,
  };

  it("rejects with BAD_USER_INPUT when the email is already verified", async () => {
    const ctx = buildContext({ ...baseUser, emailVerified: true });
    await expect(requestEmailVerification(null, {}, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("rejects with RATE_LIMITED when a token was issued within the throttle window", async () => {
    const ctx = buildContext(baseUser, {
      verification: {
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date() }),
      },
    });
    await expect(requestEmailVerification(null, {}, ctx)).rejects.toMatchObject({
      extensions: { code: "RATE_LIMITED" },
    });
  });

  it("clears old tokens, creates a new one and sends the email on the happy path", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({ id: "v1" });
    const ctx = buildContext(baseUser, {
      verification: {
        // Older than the 5-minute throttle window.
        findFirst: vi.fn().mockResolvedValue({
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        }),
        deleteMany,
        create,
      },
    });
    await expect(requestEmailVerification(null, {}, ctx)).resolves.toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { identifier: baseUser.email } });
    expect(create).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe(baseUser.email);
  });

  it("surfaces INTERNAL_SERVER_ERROR when sending the email fails", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const ctx = buildContext(baseUser, {
      verification: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({ id: "v1" }),
      },
    });
    await expect(requestEmailVerification(null, {}, ctx)).rejects.toMatchObject({
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  });
});

describe("Mutation.verifyEmail", () => {
  it("rejects an invalid or expired token with BAD_USER_INPUT", async () => {
    const ctx = buildContext(null, {
      verification: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(verifyEmail(null, { token: "nope" }, ctx)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("marks the email verified and consumes the token on success", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const del = vi.fn().mockResolvedValue({ id: "v1" });
    const ctx = buildContext(null, {
      verification: {
        findFirst: vi.fn().mockResolvedValue({ id: "v1", identifier: "a@b.dev" }),
        delete: del,
      },
      user: { updateMany },
    });
    await expect(verifyEmail(null, { token: "tok" }, ctx)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { email: "a@b.dev" },
      data: { emailVerified: true },
    });
    expect(del).toHaveBeenCalledWith({ where: { id: "v1" } });
  });
});

describe("Mutation.requestPasswordReset", () => {
  it("returns true without sending mail for an unknown email (no enumeration)", async () => {
    const create = vi.fn();
    const ctx = buildContext(null, {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      verification: { create },
    });
    await expect(
      requestPasswordReset(null, { email: "ghost@b.dev" }, ctx),
    ).resolves.toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("silently returns true (no new token) when throttled", async () => {
    const create = vi.fn();
    const deleteMany = vi.fn();
    const ctx = buildContext(null, {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date() }),
        create,
        deleteMany,
      },
    });
    await expect(
      requestPasswordReset(null, { email: "a@b.dev" }, ctx),
    ).resolves.toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("creates a reset token and sends mail on the happy path", async () => {
    const create = vi.fn().mockResolvedValue({ id: "v1" });
    const ctx = buildContext(null, {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      verification: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create,
      },
    });
    await expect(
      requestPasswordReset(null, { email: "a@b.dev" }, ctx),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data.identifier).toBe("password-reset:a@b.dev");
    expect(sendMock).toHaveBeenCalledOnce();
  });
});

describe("Mutation.resetPassword", () => {
  it("rejects a password shorter than 8 chars with BAD_USER_INPUT", async () => {
    await expect(
      resetPassword(null, { token: "t", newPassword: "short" }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects an invalid or expired reset token with BAD_USER_INPUT", async () => {
    const ctx = buildContext(null, {
      verification: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      resetPassword(null, { token: "bad", newPassword: "longenough" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("throws NOT_FOUND when the token's user no longer exists", async () => {
    const ctx = buildContext(null, {
      verification: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "v1", identifier: "password-reset:a@b.dev" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      resetPassword(null, { token: "tok", newPassword: "longenough" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("updates the credential account password and consumes the token", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    // The token is claimed with an atomic deleteMany, not a delete — see
    // the concurrent-claim guard in services/password-reset.ts.
    const del = vi.fn().mockResolvedValue({ count: 1 });
    const ctx = buildContext(null, {
      verification: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "v1", identifier: "password-reset:a@b.dev" }),
        deleteMany: del,
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "A" }) },
      account: { updateMany },
    });
    await expect(
      resetPassword(null, { token: "tok", newPassword: "longenough" }, ctx),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0][0].where).toEqual({
      userId: "u1",
      providerId: "credential",
    });
    expect(del).toHaveBeenCalledWith({ where: { id: "v1" } });
  });
});
