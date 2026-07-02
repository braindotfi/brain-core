import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("check-invariants passes", () => {
  execFileSync(process.execPath, ["scripts/check-invariants.mjs"], {
    cwd: new URL("../..", import.meta.url),
    stdio: "pipe",
  });
});
