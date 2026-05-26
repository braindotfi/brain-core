import { configDefaults, defineConfig } from "vitest/config";

// Per-service vitest config. Keeps each service self-contained so `vitest run`
// from the service dir or via `pnpm -r run test` produces consistent output.
// §7.1: 80% line coverage enforced in CI.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Integration tests (*.integration.test.ts) run only via the dedicated
    // integration config, AFTER migrations are applied. They must not run in
    // the unit/coverage pass: when DATABASE_URL is set (CI main.yml) they would
    // otherwise execute against an unmigrated DB.
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/**/*.mock.ts",
        // Require integration or live-API tests; excluded from unit coverage gate:
        "src/deps.ts",
        "src/server.ts",
        "src/__integration__/**",
        "src/routes/**",
        "src/sources/routes.ts",
        "src/adapters/plaid.ts",
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
