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
      },
    },
  },
});
