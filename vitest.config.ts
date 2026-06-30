import { defineConfig } from "vitest/config";

// Vitest config for clear-api. Tests live under `tests/` (kept out of `src/`
// so `tsc -p tsconfig.json` doesn't emit them to `dist/`). `setupFiles` loads
// `.env` so the integration tests can connect to the same DB the app uses.
export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000, // PostGIS queries on cold connections can be slow
    include: ["tests/**/*.test.ts"],
    // The DB-backed integration tests all hit ONE real database with fixed,
    // overlapping fixtures (e.g. a Sudan-wide level-0 polygon in
    // location.resolver.test.ts vs. Sudan coordinates in geo-resolve.test.ts).
    // Run files serially so each file's afterAll cleanup completes before the
    // next file starts — parallel workers otherwise see each other's
    // uncommitted-to-cleanup rows and produce flaky cross-file failures.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // Generated client, type-only/scalar defs, and the server bootstrap
      // (exercised by integration/e2e, not unit tests) would only dilute the
      // numbers.
      exclude: [
        "src/generated/**",
        "src/index.ts",
        "src/schema/**",
        "src/docs/**",
        "src/home/**",
        "src/portal/**",
        "**/*.d.ts",
      ],
    },
  },
});
