import { defineConfig } from "vitest/config";

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
        // Require integration tests; excluded from unit coverage gate:
        "src/auth.ts",
        "src/index.ts",
        "src/resources.ts",
        "src/transport/http.ts",
        "src/tools/agent.ts",
        "src/tools/ledger.ts",
        "src/tools/raw.ts",
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
