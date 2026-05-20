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
        // Require integration or live-chain tests; excluded from unit coverage gate:
        "src/routes.ts",
        "src/server.ts",
        "src/webhooks.ts",
        "src/publisher.ts",
        "src/deps.ts",
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
