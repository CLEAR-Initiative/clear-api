import { describe } from "vitest";

/**
 * Gates for DB-backed integration tests.
 *
 * They run when a database is configured AND the run hasn't opted out. CI's
 * main job sets `SKIP_DB_TESTS=1` (with dummy env vars so the modules still
 * import) to run only the DB-free suite with coverage; CI's db-tests job and
 * `bun run test:db` run against a fresh, migrated, unseeded database with
 * `SCRATCH_DB=1`; local runs with a real DATABASE_URL get everything.
 *
 * Note: even when these `describe` blocks are skipped, Vitest still evaluates
 * each test file's top-level imports at collection time — which pull in
 * `src/utils/env.ts`. So a skipping run still needs DATABASE_URL / the auth
 * vars present (real or dummy) for the env-schema parse to succeed.
 */
export const dbTestsEnabled =
  !!process.env.DATABASE_URL && process.env.SKIP_DB_TESTS !== "1";

/**
 * A self-seeding suite: it creates every row it needs and deletes them in
 * afterAll, so it runs against an empty migrated database (and in CI).
 */
export const describeIfDb = dbTestsEnabled ? describe : describe.skip;

/**
 * A suite that depends on dev-DB seed data — specific source UUIDs or the
 * Sudan PostGIS admin polygons — so it can't run on a scratch database.
 * Prefer making a suite self-seeding and using `describeIfDb`.
 */
export const describeIfSeededDb =
  dbTestsEnabled && process.env.SCRATCH_DB !== "1" ? describe : describe.skip;
