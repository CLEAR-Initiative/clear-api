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

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });
}

export { Sentry };

/**
 * Apollo Server plugin that ships unhandled GraphQL errors to Sentry.
 * Apollo catches errors internally before Sentry's global handler sees them,
 * so without this plugin the only errors that report are ones thrown outside
 * the resolver chain (auth middleware, etc.).
 */
export const sentryApolloPlugin = {
  async requestDidStart() {
    return {
      async didEncounterErrors(ctx: { errors: readonly unknown[]; request: { query?: string; operationName?: string } }) {
        if (!dsn) return; // SDK not initialised — skip cheaply
        for (const err of ctx.errors) {
          Sentry.captureException(err, {
            tags: { graphql_operation: ctx.request.operationName ?? "anonymous" },
            extra: { query: ctx.request.query },
          });
        }
      },
    };
  },
};
