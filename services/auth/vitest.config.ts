import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    // Integration tests (*.integration.test.ts) run only via
    // vitest.integration.config.ts, AFTER migrations + the DB role model are
    // applied. They must not run in the plain unit pass, matching
    // services/raw's split.
    exclude: [...configDefaults.exclude, "test/**/*.integration.test.ts"],
  },
});
