import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config. Picks up *.integration.test.ts only and
 * requires DATABASE_URL (the CI integration job provides a migrated Postgres).
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // runProjectionCycle is CROSS-TENANT: it polls every unconsumed raw_parsed
    // row across tenants. Two integration files running concurrently against a
    // shared DB can therefore interleave cycles and process an invoice before
    // its contact commits (null counterparty ref). Serialize the files so each
    // owns the projection cycle while it runs. (Production runs a single worker,
    // which always orders contacts ahead of invoices within a cycle.)
    fileParallelism: false,
  },
});
