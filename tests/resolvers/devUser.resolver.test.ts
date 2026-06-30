/**
 * Unit tests for `devUser.resolver.ts` — the developer-waitlist / dev-user
 * provisioning flow (admin creates a dev user + initial API key, and rotates
 * a dev user's key).
 *
 * DB-free: `context.prisma` is stubbed per-test with `vi.fn()` delegates, so
 * these run in CI with no database. The messaging module (`getEmailProvider`,
 * `templates`) and the activity-log helper are `vi.mock`ed before the resolver
 * is imported, so no real email is sent and no real `activity_logs` write is
 * attempted. The pure `generateApiKey` crypto helper is left to run for real —
 * it has no I/O and lets us assert on the `sk_live_` plaintext shape.
 *
 * Coverage:
 *   createDevUser
 *     - admin-only gate (UNAUTHENTICATED / FORBIDDEN)
 *     - email validation (invalid address, normalisation lower/trim)
 *     - name-required validation
 *     - duplicate-email dedup (BAD_USER_INPUT, no transaction)
 *     - happy path: transactional user+key create, plaintext returned,
 *       set-password token issued (deleteMany + create), welcome email sent,
 *       audit logged with per-step flags
 *     - keyName default vs trimmed override
 *     - set-password-token failure is swallowed (flag false, email still sent)
 *     - welcome-email failure is swallowed (flag false, still returns + logs)
 *   rotateDevUserApiKey
 *     - admin-only gate
 *     - NOT_FOUND for unknown user
 *     - happy path: revoke active keys, mint new key, notify, audit
 *     - post-rotation cap guard (INTERNAL_SERVER_ERROR)
 *     - rotation-email failure swallowed (flag false)
 *
 * Skipped (intentionally): the exact welcome-email template argument wiring and
 * the `FRONTEND_URL` graphql/docs URL formatting — these are pure string
 * plumbing into a mocked template with no branching, so asserting them would
 * only restate the implementation. We assert the provider is/ isn't called and
 * the per-step result flags, which is the behaviour that matters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

// `vi.hoisted` so these mocks exist before the hoisted `vi.mock` factories run.
const { sendMock, welcomeDevUserMock, logActivityMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  welcomeDevUserMock: vi.fn(() => ({
    subject: "welcome",
    textBody: "t",
    htmlBody: "<p>",
  })),
  logActivityMock: vi.fn(async () => undefined),
}));

// Mock messaging BEFORE importing the resolver. getEmailProvider yields a
// provider whose send() we assert on; templates.welcomeDevUser returns a
// minimal {subject,textBody,htmlBody}.
vi.mock("../../src/services/messaging/index.js", () => ({
  getEmailProvider: vi.fn(async () => ({ send: sendMock })),
  templates: { welcomeDevUser: welcomeDevUserMock },
}));

// Mock the activity logger so no row is written and so we can confirm the
// audit call's shape without touching prisma.activityLogs.
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

import { devUserResolvers } from "../../src/resolvers/devUser.resolver.js";
import type { Context } from "../../src/context.js";

type User = { id: string; role: string } | null;
type PrismaStub = Record<string, unknown>;

function buildContext(user: User, prisma: PrismaStub = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const admin: User = { id: "admin1", role: "admin" };
const viewer: User = { id: "u1", role: "viewer" };

const { createDevUser, rotateDevUserApiKey } = devUserResolvers.Mutation;

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
  welcomeDevUserMock.mockClear();
  logActivityMock.mockClear();
  logActivityMock.mockResolvedValue(undefined);
});

// A prisma stub for the createDevUser happy path. $transaction runs the passed
// callback against a tx whose user.create / apiKeys.create are the supplied
// fns, so callers can assert on them.
function happyCreatePrisma(opts: {
  existing?: unknown;
  userCreate: ReturnType<typeof vi.fn>;
  apiKeysCreate: ReturnType<typeof vi.fn>;
  verificationDeleteMany?: ReturnType<typeof vi.fn>;
  verificationCreate?: ReturnType<typeof vi.fn>;
}): PrismaStub {
  const tx = {
    user: { create: opts.userCreate },
    apiKeys: { create: opts.apiKeysCreate },
  };
  return {
    user: { findUnique: vi.fn().mockResolvedValue(opts.existing ?? null) },
    verification: {
      deleteMany:
        opts.verificationDeleteMany ?? vi.fn().mockResolvedValue({ count: 0 }),
      create: opts.verificationCreate ?? vi.fn().mockResolvedValue({ id: "v1" }),
    },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
}

describe("Mutation.createDevUser", () => {
  const baseInput = { email: "Dev@Example.com", name: "Dev Person" };

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      createDevUser(null, { input: baseInput }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    await expect(
      createDevUser(null, { input: baseInput }, buildContext(viewer)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects an invalid email with BAD_USER_INPUT before touching prisma", async () => {
    const findUnique = vi.fn();
    const ctx = buildContext(admin, { user: { findUnique } });
    await expect(
      createDevUser(null, { input: { email: "not-an-email", name: "A" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a blank name with BAD_USER_INPUT", async () => {
    const ctx = buildContext(admin, { user: { findUnique: vi.fn() } });
    await expect(
      createDevUser(null, { input: { email: "a@b.dev", name: "   " } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects a duplicate email with BAD_USER_INPUT and never opens a transaction", async () => {
    const $transaction = vi.fn();
    const ctx = buildContext(admin, {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "existing" }) },
      $transaction,
    });
    await expect(
      createDevUser(null, { input: baseInput }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("normalises the email (lowercase + trim) for the dedup lookup", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "existing" });
    const ctx = buildContext(admin, { user: { findUnique }, $transaction: vi.fn() });
    await createDevUser(
      null,
      { input: { email: "  MixedCase@Example.COM ", name: "A" } },
      ctx,
    ).catch(() => undefined);
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: "mixedcase@example.com" },
    });
  });

  it("provisions a user + key, issues a set-password token, sends the welcome email, and audits", async () => {
    const createdUser = { id: "new1", email: "dev@example.com", name: "Dev Person" };
    const userCreate = vi.fn().mockResolvedValue(createdUser);
    const apiKeysCreate = vi.fn().mockResolvedValue({ id: "k1" });
    const verificationDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const verificationCreate = vi.fn().mockResolvedValue({ id: "v1" });
    const ctx = buildContext(
      admin,
      happyCreatePrisma({
        userCreate,
        apiKeysCreate,
        verificationDeleteMany,
        verificationCreate,
      }),
    );

    const result = await createDevUser(null, { input: baseInput }, ctx);

    // Result shape: plaintext returned once, both per-step flags true.
    expect(result.user).toBe(createdUser);
    expect(result.plaintextKey).toMatch(/^sk_live_/);
    expect(result.welcomeEmailSent).toBe(true);
    expect(result.setPasswordTokenIssued).toBe(true);

    // User row created with the normalised email and the vouched-for defaults.
    const userData = userCreate.mock.calls[0][0].data;
    expect(userData.email).toBe("dev@example.com");
    expect(userData.name).toBe("Dev Person");
    expect(userData.emailVerified).toBe(true);
    expect(userData.isActive).toBe(true);
    expect(userData.role).toBe("viewer");

    // Key row carries the new user's id, a prefix + hash, and no expiry.
    const keyData = apiKeysCreate.mock.calls[0][0].data;
    expect(keyData.userId).toBe("new1");
    expect(keyData.name).toBe("Initial dev key");
    expect(keyData.prefix).toMatch(/^sk_live_/);
    expect(typeof keyData.keyHash).toBe("string");
    expect(keyData.expiresAt).toBeNull();

    // Set-password token: old tokens cleared for this email, new one created.
    expect(verificationDeleteMany).toHaveBeenCalledWith({
      where: { identifier: "password-reset:dev@example.com" },
    });
    expect(verificationCreate).toHaveBeenCalledOnce();
    expect(verificationCreate.mock.calls[0][0].data.identifier).toBe(
      "password-reset:dev@example.com",
    );

    // Welcome email sent to the new user.
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe("dev@example.com");

    // Audit attributed to the admin, never includes the plaintext key.
    expect(logActivityMock).toHaveBeenCalledOnce();
    const [, logOpts] = logActivityMock.mock.calls[0];
    expect(logOpts.userId).toBe("admin1");
    expect(logOpts.action).toBe("dev_user.provisioned");
    expect(logOpts.resourceId).toBe("new1");
    expect(logOpts.metadata).toMatchObject({
      email: "dev@example.com",
      welcomeEmailSent: true,
      setPasswordTokenIssued: true,
    });
    expect(JSON.stringify(logOpts)).not.toContain(result.plaintextKey);
  });

  it("uses a trimmed custom keyName when provided", async () => {
    const apiKeysCreate = vi.fn().mockResolvedValue({ id: "k1" });
    const ctx = buildContext(
      admin,
      happyCreatePrisma({
        userCreate: vi.fn().mockResolvedValue({ id: "new1" }),
        apiKeysCreate,
      }),
    );
    await createDevUser(
      null,
      { input: { ...baseInput, keyName: "  CI runner  " } },
      ctx,
    );
    expect(apiKeysCreate.mock.calls[0][0].data.name).toBe("CI runner");
  });

  it("falls back to the default key name when keyName is blank", async () => {
    const apiKeysCreate = vi.fn().mockResolvedValue({ id: "k1" });
    const ctx = buildContext(
      admin,
      happyCreatePrisma({
        userCreate: vi.fn().mockResolvedValue({ id: "new1" }),
        apiKeysCreate,
      }),
    );
    await createDevUser(null, { input: { ...baseInput, keyName: "   " } }, ctx);
    expect(apiKeysCreate.mock.calls[0][0].data.name).toBe("Initial dev key");
  });

  it("swallows a set-password-token failure: flag false, email still sent, still returns", async () => {
    const ctx = buildContext(
      admin,
      happyCreatePrisma({
        userCreate: vi.fn().mockResolvedValue({ id: "new1" }),
        apiKeysCreate: vi.fn().mockResolvedValue({ id: "k1" }),
        verificationDeleteMany: vi.fn().mockRejectedValue(new Error("db blip")),
      }),
    );
    const result = await createDevUser(null, { input: baseInput }, ctx);
    expect(result.setPasswordTokenIssued).toBe(false);
    // The welcome email is independent of the token step.
    expect(result.welcomeEmailSent).toBe(true);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(logActivityMock.mock.calls[0][1].metadata.setPasswordTokenIssued).toBe(
      false,
    );
  });

  it("swallows a welcome-email failure: flag false, still returns and audits", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const ctx = buildContext(
      admin,
      happyCreatePrisma({
        userCreate: vi.fn().mockResolvedValue({ id: "new1" }),
        apiKeysCreate: vi.fn().mockResolvedValue({ id: "k1" }),
      }),
    );
    const result = await createDevUser(null, { input: baseInput }, ctx);
    expect(result.welcomeEmailSent).toBe(false);
    // Token step succeeded independently.
    expect(result.setPasswordTokenIssued).toBe(true);
    expect(result.plaintextKey).toMatch(/^sk_live_/);
    expect(logActivityMock).toHaveBeenCalledOnce();
    expect(logActivityMock.mock.calls[0][1].metadata.welcomeEmailSent).toBe(false);
  });
});

describe("Mutation.rotateDevUserApiKey", () => {
  const targetUser = { id: "u9", email: "rot@example.com", name: "Rot" };

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      rotateDevUserApiKey(null, { userId: "u9" }, buildContext(null)),
    ).rejects.toMatchObject({ extensions: { code: "UNAUTHENTICATED" } });
  });

  it("throws FORBIDDEN for a non-admin caller", async () => {
    await expect(
      rotateDevUserApiKey(null, { userId: "u9" }, buildContext(viewer)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("throws NOT_FOUND when the target user does not exist", async () => {
    const updateMany = vi.fn();
    const ctx = buildContext(admin, {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      apiKeys: { updateMany },
    });
    await expect(
      rotateDevUserApiKey(null, { userId: "missing" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("revokes active keys, mints a new key, notifies, and audits", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const count = vi.fn().mockResolvedValue(0);
    const create = vi.fn().mockResolvedValue({ id: "k2" });
    const ctx = buildContext(admin, {
      user: { findUnique: vi.fn().mockResolvedValue(targetUser) },
      apiKeys: { updateMany, count, create },
    });

    const result = await rotateDevUserApiKey(null, { userId: "u9" }, ctx);

    expect(result.user).toBe(targetUser);
    expect(result.plaintextKey).toMatch(/^sk_live_/);
    expect(result.notificationEmailSent).toBe(true);

    // All currently-active keys revoked with a timestamp.
    expect(updateMany.mock.calls[0][0].where).toEqual({
      userId: "u9",
      revokedAt: null,
    });
    expect(updateMany.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);

    // New key minted for the target user.
    const keyData = create.mock.calls[0][0].data;
    expect(keyData.userId).toBe("u9");
    expect(keyData.name).toBe("Rotated dev key");
    expect(keyData.expiresAt).toBeNull();

    // Notification sent to the user; audit attributed to the admin.
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].to).toBe("rot@example.com");
    expect(logActivityMock.mock.calls[0][1].action).toBe(
      "dev_user.api_key_rotated",
    );
    expect(logActivityMock.mock.calls[0][1].metadata.notificationEmailSent).toBe(
      true,
    );
  });

  it("throws INTERNAL_SERVER_ERROR if the active-key count is still at the cap after revoking", async () => {
    const create = vi.fn();
    const ctx = buildContext(admin, {
      user: { findUnique: vi.fn().mockResolvedValue(targetUser) },
      apiKeys: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(10),
        create,
      },
    });
    await expect(
      rotateDevUserApiKey(null, { userId: "u9" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "INTERNAL_SERVER_ERROR" } });
    expect(create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("swallows a rotation-email failure: flag false, still mints, returns and audits", async () => {
    sendMock.mockRejectedValue(new Error("smtp down"));
    const create = vi.fn().mockResolvedValue({ id: "k2" });
    const ctx = buildContext(admin, {
      user: { findUnique: vi.fn().mockResolvedValue(targetUser) },
      apiKeys: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
        create,
      },
    });
    const result = await rotateDevUserApiKey(null, { userId: "u9" }, ctx);
    expect(result.notificationEmailSent).toBe(false);
    expect(result.plaintextKey).toMatch(/^sk_live_/);
    expect(create).toHaveBeenCalledOnce();
    expect(logActivityMock.mock.calls[0][1].metadata.notificationEmailSent).toBe(
      false,
    );
  });
});
