import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  STAGING_DOCUMENT_SMOKE_FIXTURES,
  writeStagingDocumentSmokeFixtures,
} from "../ops/write-staging-document-smoke-fixtures.mjs";

test("writes the four core-owned staging document smoke fixtures", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "brain-staging-document-smoke-"));
  try {
    const fixtures = writeStagingDocumentSmokeFixtures(outputDir);
    assert.deepEqual(
      fixtures.map((fixture) => fixture.filename),
      STAGING_DOCUMENT_SMOKE_FIXTURES.map((fixture) => fixture.filename),
    );
    assert.equal(fixtures.length, 4);
    for (const fixture of fixtures) {
      assert.ok(readFileSync(fixture.path).length > 0, `${fixture.filename} must not be empty`);
    }
    assert.match(readFileSync(join(outputDir, "form_1120_2025.pdf"), "latin1"), /^%PDF-1\.4/);
    assert.match(
      readFileSync(join(outputDir, "crypto_wallet_2026-08-04.csv"), "utf8"),
      /Brightline Treasury Wallet/,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
