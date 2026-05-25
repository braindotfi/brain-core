import { defineConfig } from "vitest/config";

/**
 * Integration config: the DB-backed adversarial vectors (tenant swap, policy
 * downgrade) that require a live Postgres via DATABASE_URL. The default
 * vitest.config.ts (src/**.test.ts) runs the logic-level vectors DB-free.
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
