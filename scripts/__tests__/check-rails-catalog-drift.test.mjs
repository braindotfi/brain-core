import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/check-rails-catalog-drift.mjs");

/**
 * Run the guard against a fixture tree: a temp dir with the same shape as
 * the real repo (services/api/src/composition/rail-catalog.ts + docs/rails-matrix.md)
 * but with hand-authored content that simulates a specific drift class.
 *
 * Returns { code, stdout, stderr }.
 */
function runGuard(catalogSrc, docSrc) {
  const root = mkdtempSync(join(tmpdir(), "rails-drift-"));
  try {
    mkdirSync(join(root, "services/api/src/composition"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "services/api/src/composition/rail-catalog.ts"), catalogSrc);
    writeFileSync(join(root, "docs/rails-matrix.md"), docSrc);
    try {
      const stdout = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        code: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ALIGNED_CATALOG = `
export const RAIL_CATALOG = [
  {
    name: "bank_ach",
    description: "ACH via Plaid",
    productionAllowed: true,
    requiredEnv: ["PLAID_CLIENT_ID", "PLAID_SECRET"],
    evmChain: false,
    auditRequired: false,
  },
];
`;

const ALIGNED_DOC = `
### \`bank_ach\`

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| Required env            | \`PLAID_CLIENT_ID\`, \`PLAID_SECRET\`                   |
| Production allowed      | yes                                                     |
| Audit required          | no                                                      |
`;

test("aligned catalog + doc returns OK", () => {
  const r = runGuard(ALIGNED_CATALOG, ALIGNED_DOC);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK \(1 rails in sync\)/);
});

test("rail present in catalog but missing from doc fails", () => {
  const catalog = ALIGNED_CATALOG.replace(
    'name: "bank_ach"',
    'name: "x402_base"',
  );
  // doc still says bank_ach; catalog now says x402_base
  const r = runGuard(catalog, ALIGNED_DOC);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /x402_base is in RAIL_CATALOG but not in docs/);
});

test("rail documented but missing from catalog fails", () => {
  const doc = ALIGNED_DOC.replace("`bank_ach`", "`escrow_base`");
  const r = runGuard(ALIGNED_CATALOG, doc);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /escrow_base is documented in docs.* but not in RAIL_CATALOG/);
});

test("productionAllowed mismatch fails", () => {
  const catalog = ALIGNED_CATALOG.replace("productionAllowed: true", "productionAllowed: false");
  const r = runGuard(catalog, ALIGNED_DOC);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /productionAllowed=false vs doc=true/);
});

test("auditRequired mismatch fails", () => {
  const catalog = ALIGNED_CATALOG.replace("auditRequired: false", "auditRequired: true");
  const r = runGuard(catalog, ALIGNED_DOC);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /auditRequired=true vs doc=false/);
});

test("requiredEnv mismatch fails", () => {
  const catalog = ALIGNED_CATALOG.replace(
    'requiredEnv: ["PLAID_CLIENT_ID", "PLAID_SECRET"]',
    'requiredEnv: ["PLAID_CLIENT_ID"]',
  );
  const r = runGuard(catalog, ALIGNED_DOC);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requiredEnv differs/);
});

test("doc using **no** with markdown bold parses as productionAllowed=false", () => {
  const doc = ALIGNED_DOC.replace(
    "| Production allowed      | yes                                                     |",
    "| Production allowed      | **no** (stub-only)                                      |",
  );
  const catalog = ALIGNED_CATALOG.replace("productionAllowed: true", "productionAllowed: false");
  const r = runGuard(catalog, doc);
  assert.equal(r.code, 0, r.stderr);
});

test("the real repo's catalog + doc are in sync", () => {
  // Sanity guard against the live tree: run the script against process.cwd()
  // (the repo root, since `pnpm run test:scripts` runs from there).
  const stdout = execFileSync("node", [SCRIPT], { encoding: "utf8" });
  assert.match(stdout, /rails-catalog-drift guard: OK/);
});
