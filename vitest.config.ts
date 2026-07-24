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
      // Coverage floor — gates the DB-FREE subset (what CI runs with
      // SKIP_DB_TESTS=1), so it must be calibrated to the DB-free number, not
      // the higher DB-backed one. Baseline measured on origin/dev
      // (2026-07-21, `SKIP_DB_TESTS=1 bun run test:coverage`):
      //   statements 50.78 · branches 42.31 · functions 47.62 · lines 51.39
      // Thresholds sit JUST below each baseline — verified that removing a
      // single covered test file (tests/services/datapoint-aggregation.test.ts,
      // → 49.85/41.30/46.92/50.69) trips every metric, so a real regression
      // can't slip through, while the intact suite passes. Line execution is
      // arch-independent, so the number reproduces on CI (ubuntu/amd64).
      // Ratchet these UP as coverage grows; never down.
      thresholds: {
        statements: 50,
        branches: 42,
        functions: 47,
        lines: 51,
      },
    },
  },
});
