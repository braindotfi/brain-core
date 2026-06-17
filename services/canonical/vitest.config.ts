import { defineConfig } from "vitest/config";

// Per-service vitest config (mirrors the other services). §7.1 coverage gate.
// Repository (DB) and worker modules are exercised by integration tests and
// excluded from the unit-coverage gate; the pure domain helpers are covered here.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // DB-backed integration tests run only via the integration config after
    // migrate. Without this, the unit coverage run (which executes BEFORE the
    // migrate step in main.yml, with DATABASE_URL set) would run them against an
    // unmigrated DB and fail. Mirrors the ledger/raw unit configs.
    exclude: ["src/__integration__/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/types.ts",
        // DB + worker plumbing: covered by *.integration.test.ts (CI integration job).
        "src/repository/**",
        "src/projectors/worker.ts",
        "src/index.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
