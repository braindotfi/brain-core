import { defineConfig } from "vitest/config";

/**
 * Integration-test config. Picks up integration/**.integration.test.ts only,
 * which require a live Postgres via DATABASE_URL. The default vitest.config.ts
 * (include: src/**.test.ts) stays DB-free so `pnpm test` runs on every PR.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["integration/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
