import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      // Coverage is ENFORCED on the deterministic, security-critical logic of
      // @brain/shared — foremost the §6 pre-execution gate (the crown jewel).
      // The package is a broad cross-cutting utility grab-bag; its external-I/O
      // adapters (blob/azure+s3, db/pool, llm/*, net/safe-fetch, webhooks/
      // outbound, auth/signer) are integration-tested, and its contracts/** are
      // pure type/interface modules with no runtime — neither belongs under a
      // unit-coverage threshold (mirrors the per-service `exclude` convention).
      // NOTE: this `include` scopes only WHICH files the THRESHOLD measures —
      // ALL `*.test.ts` still run in CI (so the §6 gate tests now execute there).
      // Add new security-critical modules here as they land.
      include: [
        "src/gate/gate.ts",
        "src/gate/snapshot.ts",
        "src/gate/evidence-validator.ts",
        "src/errors.ts",
        "src/config.ts",
        "src/hashing.ts",
        "src/tracing.ts",
        "src/audit/emitter.ts",
        "src/audit/hash.ts",
        "src/auth/scopes.ts",
        "src/auth/revocation.ts",
        "src/crypto/aes-gcm.ts",
        "src/events/bus.ts",
        "src/queue/dead-letters.ts",
        "src/queue/plaid.ts",
        "src/agents/capability.ts",
        "src/agents/execution-mode.ts",
      ],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/types.ts", "src/**/*.mock.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
