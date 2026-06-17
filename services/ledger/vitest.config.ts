import { defineConfig } from "vitest/config";

// §8.1: 80% line coverage. Coverage thresholds enforced.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    exclude: ["src/__integration__/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/__integration__/**",
        // Require integration tests; excluded from unit coverage gate:
        "src/deps.ts",
        "src/index.ts",
        "src/server.ts",
        "src/routes/**",
        "src/cash_flows/routes.ts",
        "src/workers/**",
        // Phase 5 projection: DB upsert/rebuild + worker, covered by integration tests.
        "src/projection/**",
        "src/reconciliation/persist.ts",
        // Test-only scaffolding (fake pg pool) shared by the matcher *.test.ts files.
        "src/reconciliation/harness.ts",
        "src/reconciliation/ReconciliationService.ts",
        "src/service/LedgerService.ts",
        "src/repository/counterparties.ts",
        "src/repository/payment_intents.ts",
        "src/repository/reconciliation_matches.ts",
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
