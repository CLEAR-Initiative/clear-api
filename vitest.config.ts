import { defineConfig } from "vitest/config";

// Vitest config for clear-api. Tests live under `tests/` (kept out of `src/`
// so `tsc -p tsconfig.json` doesn't emit them to `dist/`). `setupFiles` loads
// `.env` so the integration tests can connect to the same DB the app uses.
export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000, // PostGIS queries on cold connections can be slow
    include: ["tests/**/*.test.ts"],
  },
});
