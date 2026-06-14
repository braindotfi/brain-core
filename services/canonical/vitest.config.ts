import { defineConfig } from "vitest/config";

// Per-service vitest config (mirrors the other services). §7.1 coverage gate.
// Repository (DB) and worker modules are exercised by integration tests and
// excluded from the unit-coverage gate; the pure domain helpers are covered here.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/types.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
