import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/e2e/**/*.integration.test.ts",
      "src/usage/commercial-entity-backfill.integration.test.ts",
      "src/commercial/commercial-shadow-api-mcp.integration.test.ts",
      "src/tenant-deletion/batched-delete.integration.test.ts",
      "src/tenant-deletion/admin-delete.integration.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
