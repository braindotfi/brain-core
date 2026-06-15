import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config. Picks up *.integration.test.ts only and
 * requires DATABASE_URL (the CI integration job provides a migrated Postgres).
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
