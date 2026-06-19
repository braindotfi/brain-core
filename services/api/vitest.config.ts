import { defineConfig } from "vitest/config";

// Per-service vitest config. Keeps each service self-contained so `vitest run`
// from the service dir or via `pnpm -r run test` produces consistent output.
// §7.1: 80% line coverage enforced in CI.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/**/*.mock.ts",
        // Require integration tests; excluded from unit coverage gate:
        "src/anchorBroadcaster.ts",
        "src/main.ts",
        "src/tenant-deletion/audit-outbox-cli.ts",
        "src/auth/siwe.ts",
        "src/sandbox/resolvers.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        // Per-file gates on the money-touching rail adapters (R-08): a global
        // aggregate can stay >=80% while a single adapter silently regresses.
        // Each glob key matches exactly one file, so the gate is per-adapter.
        // Gated on lines/functions/statements (R-08's exit criterion is line-
        // coverage parity with the gate); branch coverage stays under the
        // aggregate gate, since e.g. plaidClient's error-mapping branches are
        // intentionally not all exercised.
        "src/rails/onchainExecutor.ts": { lines: 80, functions: 80, statements: 80 },
        "src/rails/plaidClient.ts": { lines: 80, functions: 80, statements: 80 },
        "src/rails/x402Client.ts": { lines: 80, functions: 80, statements: 80 },
      },
    },
  },
});
