import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/prod-tenant-diagnostics.yml");

test("ingestion lineage diagnostic is fixed-shape and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /ingestion_lineage:/);
  assert.match(workflow, /INGESTION_LINEAGE/);
  assert.match(workflow, /ingestion_lineage must be true or false/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /raw artifacts and projection status/);
  assert.match(workflow, /parsed extraction payloads/);
  assert.match(workflow, /raw interpretation outcomes/);
  assert.match(workflow, /document extraction job outcomes/);
  assert.match(workflow, /canonical projection log/);
  assert.match(workflow, /ledger invoices/);
  assert.match(workflow, /ledger obligations/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});
