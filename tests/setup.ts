/// <reference types="node" />

// Vitest sets NODE_ENV=test by default, but src/utils/env.ts validates it
// against {development, staging, production}. Force "development" before any
// app module loads so the env-schema parse succeeds.
process.env.NODE_ENV = "development";

// Load .env so DATABASE_URL (and the rest of the env-schema variables) are
// available to Prisma. Matches the app's own entrypoint
// (`src/index.ts: import "dotenv/config"`).
import "dotenv/config";

// The Task suites exercise a two-source fan-out (several Workers proposing on
// one Event), which the code still supports; production defaults to the web
// kind alone (env.ts). Keep both here unless a run sets its own list.
process.env.TASK_IMPACT_PRIOR_KINDS ??= "event.impact_prior.clear,event.impact_prior.web";
