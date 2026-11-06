/// <reference types="node" />

// Vitest sets NODE_ENV=test by default, but src/utils/env.ts validates it
// against {development, staging, production}. Force "development" before any
// app module loads so the env-schema parse succeeds.
process.env.NODE_ENV = "development";

// Load .env so DATABASE_URL (and the rest of the env-schema variables) are
// available to Prisma. Matches the app's own entrypoint
// (`src/index.ts: import "dotenv/config"`).
import "dotenv/config";

import { assertSafeTestDatabase } from "./test-guards.js";

// Neutralise the outbound channels for the whole suite, overriding any `.env`
// value (this runs after dotenv). A DB-backed test that completes/fails Tasks
// calls notifyTaskOutcome, which emails real admins through the configured
// provider — so without this a stray `bun test` against a live DB + real
// Postmark floods inboxes. `none` selects the Null providers (registry.ts);
// tests that need to assert on email mock the messaging module themselves.
process.env.EMAIL_PROVIDER = "none";
process.env.SMS_PROVIDER = "none";

// Refuse to run DB-backed tests against anything but a throwaway database.
// `scripts/test-db.sh` sets SCRATCH_DB=1; `test:ci` sets SKIP_DB_TESTS=1.
// A plain `bun test` whose `.env` points DATABASE_URL at a real/tunnelled DB
// aborts here instead of writing rows into it.
assertSafeTestDatabase(process.env);

// The Task suites exercise a two-source fan-out (several Workers proposing on
// one Event), which the code still supports; production defaults to the web
// kind alone (env.ts). `satellite` is fictional: it stands in for any later
// source (the real second source, `.clear`, is retired and would be dropped).
// Set after dotenv on purpose, overriding any `.env` value: the suites assert
// two Tasks per request whatever a developer's `.env` says. env-task.test.ts
// stubs this variable itself to test the default.
process.env.TASK_IMPACT_PRIOR_KINDS = "event.impact_prior.satellite,event.impact_prior.web";
