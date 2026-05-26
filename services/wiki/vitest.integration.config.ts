import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config. Picks up *.integration.test.ts only.
 * Unit-test config (vitest.config.ts) stays the default for `vitest run`.
 *
 * This file was referenced by the integration test script but missing on
 * disk, which hard-failed the main.yml integration step ("failed to load
 * config"). Restored to mirror the raw service's integration config.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // TODO(brain-hardening): wiki has no *.integration.test.ts yet; §7.1 owes
    // happy/error-path integration coverage for its endpoints. Until those land,
    // an empty integration suite must pass rather than error the CI step.
    passWithNoTests: true,
  },
});
