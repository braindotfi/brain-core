import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.e2e.test.ts"],
    testTimeout: 300_000, // E2E waits on real systems — 5-minute cap.
    hookTimeout: 120_000,
  },
});
