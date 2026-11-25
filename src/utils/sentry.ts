/**
 * Sentry error tracking initialisation.
 *
 * Env vars:
 *   SENTRY_DSN  — Sentry project DSN (required to enable)
 *   SENTRY_ENV  — Sentry environment label (default: NODE_ENV)
 *   SENTRY_TRACES_SAMPLE_RATE — 0..1 share of requests traced (default: 0).
 *     Tracing is off by default: at 1.0 on dev, the SDK's own sends to
 *     GlitchTip kept generating traces, a loop of ~20 new TLS connections/s
 *     that pinned clear-api's main thread at 100% CPU.
 */

import type { ApolloServerPlugin, GraphQLRequestContextDidEncounterErrors } from "@apollo/server";
import * as Sentry from "@sentry/node";
import { getOperationAST, type DocumentNode } from "graphql";

import type { Context } from "../context.js";
import { createLogger } from "./logger.js";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
    beforeSend: scrubEvent,
  });
}

export { Sentry };

/**
 * Query parameters that carry a credential. `/webhooks/glitchtip?token=` and
 * the Brief unsubscribe link take their secret in the query string (GlitchTip's
 * webhook recipient can send neither a header nor a signature), and the SDK
 * attaches the request URL and query string to every event. Without this, an
 * error inside those routes would copy the secret into GlitchTip, where anyone
 * with read access to the project can see it.
 */
const SECRET_QUERY_PARAMS = new Set(["token", "key", "api_key", "secret", "signature"]);
const REDACTED = "[Filtered]";

function isSecretParam(name: string): boolean {
  return SECRET_QUERY_PARAMS.has(name.toLowerCase());
}

function scrubQueryString(qs: string): string {
  const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
  let changed = false;
  for (const name of [...new Set(params.keys())]) {
    if (isSecretParam(name)) {
      params.set(name, REDACTED);
      changed = true;
    }
  }
  return changed ? params.toString() : qs;
}

function scrubUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const end = hash === -1 ? url.length : hash;
  return url.slice(0, q + 1) + scrubQueryString(url.slice(q + 1, end)) + url.slice(end);
}

type SentryEvent = Parameters<NonNullable<Sentry.NodeOptions["beforeSend"]>>[0];

/** Drop credentials from an event before it leaves the process. */
export function scrubEvent<E extends SentryEvent>(event: E): E {
  const request = event.request;
  if (!request) return event;
  if (request.headers) {
    delete request.headers["authorization"];
    delete request.headers["cookie"];
  }
  if (typeof request.url === "string") request.url = scrubUrl(request.url);
  const qs = request.query_string;
  if (typeof qs === "string") {
    request.query_string = scrubQueryString(qs);
  } else if (Array.isArray(qs)) {
    request.query_string = qs.map(([k, v]) => [k, isSecretParam(k) ? REDACTED : v] as [string, string]);
  } else if (qs && typeof qs === "object") {
    request.query_string = Object.fromEntries(
      Object.entries(qs).map(([k, v]) => [k, isSecretParam(k) ? REDACTED : v]),
    );
  }
  return event;
}

/**
 * Error codes for failures that are the caller's, not clear-api's. They are
 * logged rather than reported, so real faults are not buried in GlitchTip.
 *
 * The decision reads `extensions.code` only, never the message. An error with
 * no code, or any code not listed here (INTERNAL_SERVER_ERROR, a database or
 * connection failure), is still reported.
 */
const EXPECTED_CLIENT_ERROR_CODES = new Set([
  // Who the caller is and what they may do: not logged in, awaiting approval,
  // not on the team, missing a role. Thrown by the guards in `auth-guard.ts`.
  "UNAUTHENTICATED",
  "FORBIDDEN",
  // A request the server could not accept: no query, a document that does not
  // parse or asks for fields the schema doesn't have (introspection while it
  // is disabled included), an unknown operation name, a bad variable or
  // argument value, an unknown persisted query.
  "BAD_REQUEST",
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
  "OPERATION_RESOLUTION_FAILURE",
  "BAD_USER_INPUT",
  "PERSISTED_QUERY_NOT_FOUND",
  "PERSISTED_QUERY_NOT_SUPPORTED",
]);

/** The error's `extensions.code` when it is an expected client error, else undefined. */
export function expectedClientErrorCode(err: unknown): string | undefined {
  // Read the code structurally, not with `instanceof GraphQLError`: graphql 16
  // ships CJS and ESM builds, and Apollo's copy can differ from ours.
  const code = (err as { extensions?: { code?: unknown } } | null)?.extensions?.code;
  return typeof code === "string" && EXPECTED_CLIENT_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * The operation's name. Apollo resolves `operationName` only after a document
 * validates, so for a validation failure it is still unset; read it from the
 * parsed document instead. A client that sends `query Foo { … }` without an
 * `operationName` field in the body is then still reported as `Foo`.
 */
export function operationNameOf(
  requested: string | null | undefined,
  document: DocumentNode | undefined,
): string {
  if (requested) return requested;
  if (!document) return "anonymous";
  return getOperationAST(document)?.name?.value ?? "anonymous";
}

type CallerContext = Pick<Context, "user" | "authMethod" | "viaAgent">;

/** Who sent the request, as Sentry tags and user. Ids only: no email or name. */
export function describeCaller(
  contextValue: Partial<CallerContext> | undefined,
  userAgent: string | undefined,
): { user?: { id: string }; tags: Record<string, string> } {
  const user = contextValue?.user;
  const tags: Record<string, string> = {
    auth_method: contextValue?.authMethod ?? "none",
    via_agent: contextValue?.viaAgent ? "yes" : "no",
  };
  if (user?.role) tags.user_role = String(user.role);
  // Sentry caps tag values at 200 characters.
  if (userAgent) tags.client = userAgent.slice(0, 200);
  return user?.id ? { user: { id: user.id }, tags } : { tags };
}

const log = createLogger("graphql");

/**
 * Apollo Server plugin that ships unhandled GraphQL errors to Sentry.
 * Apollo catches errors internally before Sentry's global handler sees them,
 * so without this plugin the only errors that report are ones thrown outside
 * the resolver chain (auth middleware, etc.).
 *
 * Each report names its caller (user id, role, auth method, User-Agent) so a
 * failing client can be traced. Expected client errors (see
 * `EXPECTED_CLIENT_ERROR_CODES`) are written to the log with the same fields
 * and their code instead of being reported.
 */
export const sentryApolloPlugin: ApolloServerPlugin<Context> = {
  async requestDidStart() {
    return {
      async didEncounterErrors(ctx: GraphQLRequestContextDidEncounterErrors<Context>) {
        const operation = operationNameOf(ctx.request.operationName, ctx.document);
        const caller = describeCaller(
          ctx.contextValue,
          ctx.request.http?.headers.get("user-agent") ?? undefined,
        );
        for (const err of ctx.errors) {
          const expectedCode = expectedClientErrorCode(err);
          if (expectedCode) {
            log.warn(
              { code: expectedCode, operation, userId: caller.user?.id, ...caller.tags },
              `expected client error: ${err.message}`,
            );
            continue;
          }
          if (!dsn) continue; // SDK not initialised
          Sentry.captureException(err, {
            user: caller.user,
            tags: { graphql_operation: operation, ...caller.tags },
            extra: { query: ctx.request.query },
          });
        }
      },
    };
  },
};
