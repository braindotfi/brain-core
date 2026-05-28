import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "agents/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
