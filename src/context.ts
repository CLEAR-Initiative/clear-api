import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";
import type { Session, User } from "./lib/auth.js";
import { resolveRequestAuth, type AuthMethod } from "./utils/request-auth.js";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  pickAcceptLanguage,
  type Locale,
} from "./utils/locales.js";
import {
  createTranslationLoader,
  type TranslationLoader,
  type TranslatableEntityType,
} from "./utils/translation-loader.js";
import { sendCeleryTask } from "./services/celery.js";

export interface Context {
  prisma: PrismaClient;
  user: User | null;
  session: Session | null;
  authMethod: AuthMethod;
  /**
   * Active locale for this request. Drives translation overlays in
   * resolvers and is fixed for the request's lifetime — switching
   * languages requires a new request.
   */
  locale: Locale;
  /**
   * Per-request batched loader for translation rows. `load()` returns
   * null when no translation exists for the active locale, letting the
   * resolver fall through to canonical English. Short-circuits to a
   * no-op when locale === "en".
   */
  translationLoader: TranslationLoader;
}

/**
 * Resolve the active locale from (in priority order):
 *   1. `NEXT_LOCALE` cookie value (forwarded by clear-mvp's BFF).
 *   2. The authenticated user's stored `language` preference.
 *   3. The request's `Accept-Language` header (first supported match).
 *   4. DEFAULT_LOCALE ("en").
 *
 * Why the cookie wins over `user.language`: Better Auth's cookieCache
 * (5 min TTL) can serve a stale user object after a profile-edit
 * mutation, so reading `user.language` would lag the UI for up to
 * 5 minutes after the user switches language. The frontend updates
 * the NEXT_LOCALE cookie synchronously via /api/locale on every
 * language change, so trusting it gives instant feedback while
 * `user.language` keeps acting as the durable fallback for
 * unauthenticated callers (M2M API-key requests, etc.).
 */
function resolveLocale(
  user: User | null,
  nextLocaleCookie: string | null,
  acceptLanguage: string | null,
): Locale {
  if (isSupportedLocale(nextLocaleCookie)) return nextLocaleCookie;
  const fromUser = user?.language;
  if (isSupportedLocale(fromUser)) return fromUser;
  return pickAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

/**
 * Pull a single cookie's value out of the raw `Cookie:` request header.
 * Kept inline rather than pulling in a parser dep — the format is
 * simple and we only ever look for one cookie at a time.
 */
function readCookie(rawHeader: string | string[] | undefined, name: string): string | null {
  const header = Array.isArray(rawHeader) ? rawHeader.join("; ") : (rawHeader ?? "");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("=") ?? "");
  }
  return null;
}

/**
 * Lazy-on-read enqueue: push a Celery task onto the shared Redis
 * broker when a resolver discovers an entity has no translation for
 * the active locale yet. The pipeline worker picks it up and
 * translates the entity asynchronously; the user's current request
 * still gets canonical English. The task is idempotent (the
 * staleness diff turns a no-op into a no-op), so duplicate enqueues
 * across requests are cheap.
 *
 * Failures are intentionally silent: a flaky broker connection must
 * not cascade into a 500 from clear-api. We log + drop and the next
 * read of the same entity will retry the enqueue.
 *
 * Wire format matches the manual-signal path (see
 * resolvers/signal.resolver.ts → sendCeleryTask) so both producers
 * use the same broker and routing key.
 */
function enqueueTranslation(
  entityType: TranslatableEntityType,
  entityId: string,
): void {
  void sendCeleryTask("src.tasks.translate.translate_entity_task", {
    entity_type: entityType,
    entity_id: entityId,
  }).catch((err: unknown) => {
    console.warn(
      `[translate-enqueue] ${entityType}=${entityId} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
}

export async function createContext(
  args: ExpressContextFunctionArgument,
): Promise<Context> {
  const { user, session, authMethod } = await resolveRequestAuth(args.req.headers);

  // Express normalises headers to lowercase string|string[]. Take the
  // first value if multi-valued — every reasonable client sends a
  // single Accept-Language header anyway.
  const rawAccept = args.req.headers["accept-language"];
  const acceptLanguage =
    Array.isArray(rawAccept) ? (rawAccept[0] ?? null) : (rawAccept ?? null);
  // NEXT_LOCALE comes from clear-mvp's BFF (next-intl's cookie). Wins
  // over user.language so a profile-edit takes effect immediately
  // even while Better Auth's 5-min cookieCache still serves the old
  // user object.
  const nextLocaleCookie = readCookie(args.req.headers["cookie"], "NEXT_LOCALE");
  const locale = resolveLocale(user, nextLocaleCookie, acceptLanguage);

  return {
    prisma,
    user,
    session,
    authMethod,
    locale,
    translationLoader: createTranslationLoader(
      prisma,
      locale,
      // Skip the lazy enqueue entirely for the canonical locale — the
      // loader short-circuits for "en" too, but being explicit here
      // matches the resolver semantic and saves a function call on
      // every English read.
      locale === DEFAULT_LOCALE ? undefined : enqueueTranslation,
    ),
  };
}
