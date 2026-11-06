/**
 * Per-request branding for user-touchpoint emails.
 *
 * clear-api is a platform other orgs build their own frontends on. Each of
 * those frontends can differ in two ways that leak into the emails we send on
 * their behalf (invitations, password reset, email verification):
 *
 *   - the **frontend base URL** that user-facing links point at, and
 *   - the **sender identity** the recipient sees.
 *
 * Rather than store these per-org (one org may run several frontends), the
 * calling frontend passes them as explicit arguments and this module merges
 * them over the platform env defaults. Nothing here touches the database.
 *
 * Sender identity never changes the authenticated `From` *address* — that must
 * stay on a domain our ESP has verified or mail silently lands in spam. We
 * brand via the `From` **display name** (`fromName`, free-form) and route
 * replies with `Reply-To` (`replyTo`). See `messaging/types.ts`.
 *
 * Frontend base URL has a sharper edge: it ends up as the host of a
 * token-bearing link. On an UNAUTHENTICATED flow (password reset) a caller
 * could otherwise point that link at an attacker's site and harvest the token
 * — a classic account-takeover. So the unauthenticated path runs the supplied
 * URL through {@link safeFrontendBase}, which honours it only when its origin
 * is operator-allowlisted (`ALLOWED_FRONTEND_ORIGINS`) and otherwise falls
 * back to `FRONTEND_URL`. Authenticated flows, where the caller is already a
 * trusted org principal, use {@link trustedFrontendBase} and take the arg as
 * given (still URL-validated).
 */

import { env } from "../utils/env.js";

export interface TouchpointParams {
  /** Frontend base URL for building links. May include a path prefix. */
  frontendBaseUrl?: string | null;
  /** Address replies should go to (becomes `Reply-To`). */
  senderEmail?: string | null;
  /** Display name for the `From` header. */
  senderName?: string | null;
}

export interface ResolvedBranding {
  /** Normalised base URL for links — origin + any path prefix, no trailing slash. */
  frontendBase: string;
  /** `Reply-To`, present only when a syntactically valid email was supplied. */
  replyTo?: string;
  /** `From` display name, present only when a non-empty name was supplied. */
  fromName?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parse a string into a URL object, or null if it isn't a valid http(s) URL. */
function parseHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Reduce a valid URL to a link base: origin + path prefix, no query/hash, no
 * trailing slash. Keeps a path prefix (e.g. `https://app.org/clear`) so
 * frontends mounted under a sub-path still get correct links.
 */
function normaliseBase(u: URL): string {
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/** The platform default base, normalised the same way as any override. */
export function defaultFrontendBase(): string {
  const u = parseHttpUrl(env.FRONTEND_URL);
  // FRONTEND_URL is operator config; if it is somehow unparseable just strip a
  // trailing slash so link-building stays well-formed.
  return u ? normaliseBase(u) : env.FRONTEND_URL.replace(/\/+$/, "");
}

/**
 * Is this URL's origin allowed to appear in an unauthenticated touchpoint
 * link? True when it matches `ALLOWED_FRONTEND_ORIGINS` or `FRONTEND_URL`'s
 * own origin (always implicitly trusted).
 */
export function isAllowedFrontendOrigin(raw: string | null | undefined): boolean {
  const u = parseHttpUrl(raw);
  if (!u) return false;
  if (env.ALLOWED_FRONTEND_ORIGINS.includes(u.origin)) return true;
  const def = parseHttpUrl(env.FRONTEND_URL);
  return def?.origin === u.origin;
}

/**
 * Base URL for an UNAUTHENTICATED flow. Honours the supplied URL only if its
 * origin is allowlisted; otherwise falls back to the platform default. Never
 * echoes an untrusted host into a token-bearing link.
 */
export function safeFrontendBase(raw: string | null | undefined): string {
  const u = parseHttpUrl(raw);
  if (u && isAllowedFrontendOrigin(raw)) return normaliseBase(u);
  return defaultFrontendBase();
}

/**
 * Base URL for an AUTHENTICATED flow, where the caller is a trusted org
 * principal. Takes the arg as given once it is a valid http(s) URL; falls
 * back to the platform default only when it is missing or malformed.
 */
export function trustedFrontendBase(raw: string | null | undefined): string {
  const u = parseHttpUrl(raw);
  return u ? normaliseBase(u) : defaultFrontendBase();
}

/** Join a base and a path into an absolute link (slash-safe). */
export function brandedUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * Resolve the sender half of a touchpoint's branding. `senderEmail` becomes
 * `Reply-To` only if syntactically valid (a bad address would otherwise break
 * the whole send); `senderName` becomes the `From` display name.
 */
export function resolveSender(
  params: TouchpointParams,
): Pick<ResolvedBranding, "replyTo" | "fromName"> {
  const out: Pick<ResolvedBranding, "replyTo" | "fromName"> = {};
  const email = params.senderEmail?.trim();
  if (email && EMAIL_RE.test(email)) out.replyTo = email;
  const name = params.senderName?.trim();
  if (name) out.fromName = name;
  return out;
}

/**
 * Full branding for a touchpoint. `trustFrontend` picks how the frontend base
 * is resolved: `true` for authenticated callers (arg trusted as-is), `false`
 * for unauthenticated ones (arg allowlist-gated).
 */
export function resolveBranding(
  params: TouchpointParams,
  { trustFrontend }: { trustFrontend: boolean },
): ResolvedBranding {
  const frontendBase = trustFrontend
    ? trustedFrontendBase(params.frontendBaseUrl)
    : safeFrontendBase(params.frontendBaseUrl);
  return { frontendBase, ...resolveSender(params) };
}
