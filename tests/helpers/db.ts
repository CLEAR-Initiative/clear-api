import { describe } from "vitest";

/**
 * Gate for DB-backed integration tests.
 *
 * These tests run against the real database (DATABASE_URL from `.env`) and
 * depend on dev-DB seed data — specific source UUIDs and Sudan PostGIS admin
 * polygons — so they can't run in a vanilla CI runner without a seeded
 * Postgres + PostGIS instance.
 *
 * They run when a database is configured AND the run hasn't explicitly opted
 * out. CI sets `SKIP_DB_TESTS=1` (and supplies dummy env vars so the modules
 * still import) to run only the DB-free suite; local runs with a real
 * DATABASE_URL get the full suite automatically.
 *
 * Note: even when these `describe` blocks are skipped, Vitest still evaluates
 * each test file's top-level imports at collection time — which pull in
 * `src/utils/env.ts`. So a skipping run still needs DATABASE_URL / the auth
 * vars present (real or dummy) for the env-schema parse to succeed.
 */
export const dbTestsEnabled =
  !!process.env.DATABASE_URL && process.env.SKIP_DB_TESTS !== "1";

export const describeIfDb = dbTestsEnabled ? describe : describe.skip;
