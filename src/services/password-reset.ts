/**
 * Shared password-reset logic, used by three surfaces that must behave
 * identically:
 *
 *   - `requestPasswordReset` / `resetPassword` GraphQL mutations
 *     (`auth.resolver.ts`)
 *   - the Developer Portal's forgot-password form (`portal/index.ts`)
 *   - the dev-user welcome email's "set your password" magic link
 *     (`devUser.resolver.ts`), which issues the same token shape with a
 *     longer TTL
 *
 * Tokens live in Better Auth's `verification` table under the
 * `password-reset:<email>` identifier. Better Auth itself is not
 * configured with `sendResetPassword`, so this module owns the flow end
 * to end — issuing the token, sending the mail, and writing the new
 * password hash back to the `credential` account row using Better
 * Auth's own hasher.
 */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../utils/env.js";
import { getEmailProvider, templates } from "./messaging/index.js";

/** Identifier prefix for reset tokens in the `verification` table. */
export const PASSWORD_RESET_IDENTIFIER_PREFIX = "password-reset:";

/** How long a forgot-password token stays valid. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Minimum gap between reset emails for the same address. */
export const RESET_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/** Mirrors Better Auth's `emailAndPassword.minPasswordLength`. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Canonical form for address lookups. `user.email` is a case-sensitive
 * unique column, so every surface must agree on this or the same person
 * resolves differently depending on how they typed their address.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Build the user-facing reset URL.
 *
 * Points at the Developer Portal page served by this same API process
 * (`BETTER_AUTH_URL` is the server's own base URL), not at
 * `FRONTEND_URL` — the Next.js app has no reset-password route, so a
 * link there is a dead end.
 *
 * `kind: "setup"` swaps the page copy to first-time "choose a password"
 * wording for the dev-user welcome flow. The token itself is identical,
 * so the flag is purely cosmetic and safe to drop.
 */
export function buildResetUrl(token: string, kind?: "setup"): string {
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const suffix = kind ? `&kind=${kind}` : "";
  return `${base}/portal/reset-password?token=${token}${suffix}`;
}

/**
 * Replace any outstanding reset tokens for `email` with a fresh one.
 *
 * Old tokens are cleared first so only the most recent email works —
 * important for the welcome flow, where a resend must invalidate the
 * previous link.
 */
export async function issueResetToken(
  prisma: PrismaClient,
  email: string,
  ttlMs: number = RESET_TOKEN_TTL_MS,
): Promise<string> {
  const identifier = `${PASSWORD_RESET_IDENTIFIER_PREFIX}${email}`;
  await prisma.verification.deleteMany({ where: { identifier } });

  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await prisma.verification.create({
    data: {
      identifier,
      value: token,
      expiresAt: new Date(now.getTime() + ttlMs),
      // `verification.createdAt` is nullable with NO database default (see
      // the init migration). Omitting it leaves NULL, which makes the
      // throttle check below silently never fire — and since
      // `POST /portal/forgot-password` is unauthenticated, that turns the
      // endpoint into an email-bombing vector. Set it explicitly.
      createdAt: now,
      updatedAt: now,
    },
  });
  return token;
}

/**
 * Handle a "I forgot my password" request.
 *
 * Deliberately indistinguishable from the outside whether the address
 * exists, is throttled, or the mail provider failed — every path
 * resolves without throwing, so callers can only ever report "if that
 * address is registered, a link is on its way". Failures are logged
 * server-side.
 */
export async function sendPasswordResetEmail(
  prisma: PrismaClient,
  rawEmail: string,
): Promise<void> {
  // Normalise here rather than at each call site. The `user.email` lookup is
  // case-sensitive, and the portal route and the GraphQL mutation used to
  // disagree about trimming/casing — which both hid accounts from one
  // surface and split the throttle across casings of the same address.
  const email = normaliseEmail(rawEmail);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const identifier = `${PASSWORD_RESET_IDENTIFIER_PREFIX}${email}`;
  const recent = await prisma.verification.findFirst({
    where: { identifier },
    // `nulls: "last"` matters: Postgres sorts NULLs FIRST on DESC, and rows
    // written before `createdAt` was set explicitly have one. Without this
    // a single legacy row would win the ordering forever and disable the
    // throttle for that address.
    orderBy: { createdAt: { sort: "desc", nulls: "last" } },
  });
  if (
    recent?.createdAt &&
    Date.now() - recent.createdAt.getTime() < RESET_THROTTLE_MS
  ) {
    // Throttled. Stay silent — surfacing this would leak that the
    // address is registered and that someone recently asked.
    return;
  }

  const token = await issueResetToken(prisma, email);
  const content = templates.passwordReset(user.name, buildResetUrl(token));

  try {
    const provider = await getEmailProvider();
    await provider.send({
      to: email,
      subject: content.subject,
      textBody: content.textBody,
      htmlBody: content.htmlBody,
    });
  } catch (error) {
    console.error(
      "[AUTH] Failed to send password reset email:",
      error instanceof Error ? error.message : error,
    );
    // Swallowed on purpose — see the enumeration note above.
  }
}

export type ResetPasswordFailure =
  | "WEAK_PASSWORD"
  | "INVALID_TOKEN"
  | "USER_NOT_FOUND";

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; reason: ResetPasswordFailure };

/**
 * Look up a token without consuming it, so a page can tell "this link is
 * dead" before the user types a new password into a form that can't
 * succeed.
 */
export async function findValidResetToken(
  prisma: PrismaClient,
  token: string,
): Promise<{ id: string; email: string } | null> {
  if (!token) return null;

  const verification = await prisma.verification.findFirst({
    where: {
      value: token,
      identifier: { startsWith: PASSWORD_RESET_IDENTIFIER_PREFIX },
      expiresAt: { gt: new Date() },
    },
  });
  if (!verification) return null;

  return {
    id: verification.id,
    email: verification.identifier.slice(
      PASSWORD_RESET_IDENTIFIER_PREFIX.length,
    ),
  };
}

/**
 * Consume a reset token and set the new password.
 *
 * On success every existing session for the user is dropped: a reset is
 * the remedy for a suspected compromise, so anyone already signed in as
 * that user — including whoever prompted the reset — is signed out.
 */
export async function resetPasswordWithToken(
  prisma: PrismaClient,
  token: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "WEAK_PASSWORD" };
  }

  const valid = await findValidResetToken(prisma, token);
  if (!valid) return { ok: false, reason: "INVALID_TOKEN" };

  // Claim the token BEFORE writing the password. `deleteMany` on the id is
  // a single atomic statement, so of two concurrent submits holding the
  // same link exactly one sees count === 1 and proceeds; the loser is told
  // the link is spent instead of racing a second password write and then
  // blowing up on a P2025 from an already-deleted row.
  const claimed = await prisma.verification.deleteMany({
    where: { id: valid.id },
  });
  if (claimed.count === 0) return { ok: false, reason: "INVALID_TOKEN" };

  const user = await prisma.user.findUnique({ where: { email: valid.email } });
  if (!user) return { ok: false, reason: "USER_NOT_FOUND" };

  const { hashPassword } = await import("better-auth/crypto");
  const hashedPassword = await hashPassword(newPassword);

  // `updateMany` rather than `update`: a user created by an admin via
  // createDevUser has no credential account row until their first
  // password is set, and updateMany on zero rows is a no-op rather than
  // a throw. The upsert for that case is handled below.
  const updated = await prisma.account.updateMany({
    where: { userId: user.id, providerId: "credential" },
    data: { password: hashedPassword },
  });

  if (updated.count === 0) {
    // First-time setup (dev-user welcome link): create the credential
    // account so the user can sign in with email + password.
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: hashedPassword,
      },
    });
  }

  // Best-effort: a stale session outliving the reset is a security
  // problem, but not one worth failing an otherwise-successful reset
  // over.
  try {
    await prisma.session.deleteMany({ where: { userId: user.id } });
  } catch (error) {
    console.error(
      "[AUTH] Failed to revoke sessions after password reset:",
      error instanceof Error ? error.message : error,
    );
  }

  return { ok: true };
}
