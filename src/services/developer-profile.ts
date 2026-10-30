/**
 * The Developer Portal Welcome page form (`/portal/welcome`): parsing,
 * validation and storage of what a Developer tells us about themselves.
 *
 * Name lives on Better Auth's `user` row (editing it here renames the
 * account); everything else is optional and lives in the 1:1
 * `developerProfile` table so Better Auth's own table stays untouched.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import type { DeveloperProfileDetails } from "./messaging/templates.js";

export type { DeveloperProfileDetails };

export const PROFILE_LIMITS = {
  name: 120,
  organisation: 200,
  url: 500,
  contributionInterest: 4000,
} as const;

/** Form field names, in the order the page renders them. */
export const PROFILE_URL_FIELDS = [
  "personalWebsite",
  "organisationWebsite",
  "linkedinUrl",
  "githubUrl",
] as const;

export type ProfileFormField = "name" | keyof DeveloperProfileDetails;

export interface ProfileFormValues extends DeveloperProfileDetails {
  name: string;
}

export type ProfileFormErrors = Partial<Record<ProfileFormField, string>>;

export type ParseProfileResult =
  | { ok: true; value: ProfileFormValues }
  | { ok: false; errors: ProfileFormErrors; values: Record<ProfileFormField, string> };

function field(body: unknown, key: string): string {
  const raw = (body as Record<string, unknown> | null | undefined)?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Normalise one URL field. Empty → null. A bare host such as
 * `github.com/ada` gets `https://` in front; any other scheme
 * (`javascript:`, `data:`, `ftp:`) is rejected rather than rewritten.
 */
export function normaliseProfileUrl(
  raw: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: null };
  if (raw.length > PROFILE_LIMITS.url) {
    return { ok: false, error: `Keep this under ${PROFILE_LIMITS.url} characters.` };
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: "Enter a full web address, like https://example.org." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// links are accepted." };
  }
  if (!url.hostname.includes(".") || /\s/.test(raw)) {
    return { ok: false, error: "Enter a full web address, like https://example.org." };
  }
  return { ok: true, value: url.toString() };
}

function optionalText(
  raw: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: null };
  if (raw.length > max) return { ok: false, error: `Keep this under ${max} characters.` };
  return { ok: true, value: raw };
}

/** Validate a submitted Welcome page form (urlencoded body). */
export function parseProfileForm(body: unknown): ParseProfileResult {
  const values: Record<ProfileFormField, string> = {
    name: field(body, "name"),
    personalWebsite: field(body, "personalWebsite"),
    organisation: field(body, "organisation"),
    organisationWebsite: field(body, "organisationWebsite"),
    linkedinUrl: field(body, "linkedinUrl"),
    githubUrl: field(body, "githubUrl"),
    contributionInterest: field(body, "contributionInterest"),
  };
  const errors: ProfileFormErrors = {};
  const out: Partial<ProfileFormValues> = {};

  if (!values.name) errors.name = "Name is required.";
  else if (values.name.length > PROFILE_LIMITS.name) {
    errors.name = `Keep this under ${PROFILE_LIMITS.name} characters.`;
  } else out.name = values.name;

  for (const key of PROFILE_URL_FIELDS) {
    const r = normaliseProfileUrl(values[key]);
    if (r.ok) out[key] = r.value;
    else errors[key] = r.error;
  }

  const org = optionalText(values.organisation, PROFILE_LIMITS.organisation);
  if (org.ok) out.organisation = org.value;
  else errors.organisation = org.error;

  const interest = optionalText(
    values.contributionInterest,
    PROFILE_LIMITS.contributionInterest,
  );
  if (interest.ok) out.contributionInterest = interest.value;
  else errors.contributionInterest = interest.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return { ok: true, value: out as ProfileFormValues };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Save the form. Returns `firstSubmission: true` only for the call that
 * created the profile row, so the maintainer notification goes out once
 * even if two submits race (the loser hits the unique index on
 * `user_id` and falls through to an update).
 */
export async function saveDeveloperProfile(
  prisma: PrismaClient,
  userId: string,
  input: ProfileFormValues,
): Promise<{ firstSubmission: boolean }> {
  const { name, ...details } = input;
  await prisma.user.update({
    where: { id: userId },
    data: { name, updatedAt: new Date() },
  });

  const existing = await prisma.developerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existing) {
    try {
      await prisma.developerProfile.create({ data: { userId, ...details } });
      return { firstSubmission: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  await prisma.developerProfile.update({ where: { userId }, data: details });
  return { firstSubmission: false };
}
