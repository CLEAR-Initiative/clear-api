import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds the test files that open a real database, for vitest's `include`
 * when `SCRATCH_DB=1` (CI's db-tests job, `bun run test:db`).
 *
 * A file counts as DB-backed when it imports `describeIfDb` or
 * `describeIfSeededDb` from `tests/helpers/db` — the gates every DB suite
 * goes through. Keying on the import rather than the call spelling means
 * `describeIfDb.only(` or `describeIfDb (` still match, and a file that
 * only mentions the helper in a comment does not. Found by scanning the
 * sources at config time rather than by a naming convention, because only
 * some of these files carry the `.db.test.ts` suffix and a hand-kept list
 * would silently drift.
 */
const DB_HELPER_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bdescribeIf(?:Seeded)?Db\b[^}]*\}\s*from\s*["'][^"']*helpers\/db(?:\.js|\.ts)?["']/;

export function isDbBackedTestSource(source: string): boolean {
  return DB_HELPER_IMPORT.test(source);
}

export function dbBackedTestFiles(dir = "tests"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return dbBackedTestFiles(path);
    if (!entry.name.endsWith(".test.ts")) return [];
    return isDbBackedTestSource(readFileSync(path, "utf8")) ? [path] : [];
  });
}
