/**
 * Sentry error tracking initialisation.
 *
 * Env vars:
 *   SENTRY_DSN  — Sentry project DSN (required to enable)
 *   SENTRY_ENV  — Sentry environment label (default: NODE_ENV)
 */

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
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
