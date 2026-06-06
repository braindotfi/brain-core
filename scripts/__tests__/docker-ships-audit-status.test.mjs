import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the review finding: the mainnet escrow boot fence reads
// contracts/audit-status.json at runtime (readAuditStatusApproved), but the
// production image excluded the whole contracts/ tree via .dockerignore and
// never copied the file -- so the fence failed closed forever, even post-audit.
// A live image build is blocked in CI's unit sandbox, so this asserts the build
// CONFIG ships the file (and stays shipping it).

const ROOT = process.cwd();
const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

test(".dockerignore re-includes contracts/audit-status.json", () => {
  // The contracts tree is excluded...
  assert.match(dockerignore, /^contracts\/\*\s*$/m, "expected contracts/* exclusion");
  // ...but the audit record is explicitly re-included.
  assert.match(
    dockerignore,
    /^!contracts\/audit-status\.json\s*$/m,
    "expected !contracts/audit-status.json negation so the file enters the build context",
  );
  // And the blanket `contracts` (whole-dir) exclusion is gone (it would prevent
  // descending into contracts/ to re-include a child).
  assert.doesNotMatch(dockerignore, /^contracts\s*$/m, "blanket `contracts` exclusion must not remain");
});

test("Dockerfile copies audit-status.json into the runtime image", () => {
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/contracts\/audit-status\.json contracts\/audit-status\.json/,
    "runtime stage must COPY contracts/audit-status.json from the builder",
  );
});

test("the file the fence reads is actually present in the repo", () => {
  // Sanity: the path the runtime fence resolves must exist to be copyable.
  const doc = JSON.parse(readFileSync(join(ROOT, "contracts/audit-status.json"), "utf8"));
  assert.equal(typeof doc.status, "string");
});
