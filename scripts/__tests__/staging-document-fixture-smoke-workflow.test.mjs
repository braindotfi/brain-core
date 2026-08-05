import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/staging-document-fixture-smoke.yml");

test("staging document smoke explicitly triggers external extraction for generic fixtures", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /POST "\$API_BASE\/v1\/raw\/\$raw_id\/extract"/);
  assert.match(workflow, /trigger_extraction form_1120_2025\.pdf "\$form_1120_raw_id"/);
  assert.match(
    workflow,
    /trigger_extraction crypto_wallet_2026-08-04\.csv "\$crypto_wallet_raw_id"/,
  );
  assert.match(workflow, /projection_status" == "projected" && "\$parsed_count" -gt 0/);
});
