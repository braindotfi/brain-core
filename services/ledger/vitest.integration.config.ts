import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // TODO(brain-hardening): ledger has no *.integration.test.ts yet; §7.1 owes
    // happy/error-path integration coverage for its endpoints. Until those land,
    // an empty integration suite must pass rather than error the CI step.
    passWithNoTests: true,
  },
});
