import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config. Picks up *.integration.test.ts only.
 * Unit-test config (vitest.config.ts) stays the default for `vitest run`.
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
