/// <reference types="node" />

// Vitest sets NODE_ENV=test by default, but src/utils/env.ts validates it
// against {development, staging, production}. Force "development" before any
// app module loads so the env-schema parse succeeds.
process.env.NODE_ENV = "development";

// Load .env so DATABASE_URL (and the rest of the env-schema variables) are
// available to Prisma. Matches the app's own entrypoint
// (`src/index.ts: import "dotenv/config"`).
import "dotenv/config";
