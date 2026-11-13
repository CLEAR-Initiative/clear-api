/**
 * Safety guards the test setup enforces so a test run can never touch a real
 * database. (Email/SMS are neutralised separately, by forcing the `none`
 * providers in setup.ts.)
 *
 * Background: `tests/setup.ts` loads `.env` so Prisma has a `DATABASE_URL`. If
 * that points at a real environment's database (e.g. a developer's tunnel on
 * `127.0.0.1:15432`), a DB-backed test would create and delete rows there and
 * fire real notifications. `scripts/test-db.sh` provisions a throwaway
 * Postgres named `clear_test` and exports `SCRATCH_DB=1`; these helpers accept
 * only that shape.
 */

type Env = Record<string, string | undefined>;

/** The database name from a Postgres connection string (no query params). */
export function parseDbName(databaseUrl: string | undefined): string {
  const lastSegment = (databaseUrl ?? "").split("/").pop() ?? "";
  return lastSegment.split("?")[0] ?? "";
}

/**
 * Is `DATABASE_URL` a disposable scratch/test database that DB tests may write
 * to? True when `scripts/test-db.sh` set `SCRATCH_DB=1`, or the database name
 * is a test name (`clear_test`, or any `*_test`). A real DB like `clear` is
 * not scratch.
 */
export function isScratchDatabase(databaseUrl: string | undefined, env: Env): boolean {
  if (env.SCRATCH_DB === "1") return true;
  const name = parseDbName(databaseUrl);
  return name === "clear_test" || name.endsWith("_test");
}

/**
 * Throw unless it is safe to run DB-backed tests: either they are skipped
 * (`SKIP_DB_TESTS=1`), or `DATABASE_URL` is a scratch database. Called once
 * from `tests/setup.ts`, so a misconfigured run aborts before any test opens a
 * connection.
 */
export function assertSafeTestDatabase(env: Env): void {
  if (env.SKIP_DB_TESTS === "1") return; // DB tests won't run at all
  if (isScratchDatabase(env.DATABASE_URL, env)) return;

  const name = parseDbName(env.DATABASE_URL) || "(unset)";
  throw new Error(
    `[tests] Refusing to run DB-backed tests against database "${name}" — it is not a ` +
      `scratch/test database. DB tests create and delete rows and can trigger real ` +
      `notifications, so they must run against a throwaway DB.\n` +
      `  • Run \`bun run test:db\` (spins up a throwaway Postgres), or\n` +
      `  • Run \`bun run test:ci\` (SKIP_DB_TESTS=1) for the DB-free suite.\n` +
      `To override on a database you know is disposable, set SCRATCH_DB=1.`,
  );
}
