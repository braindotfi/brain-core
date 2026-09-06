import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../ops/release-commercial-demo-blob-legal-holds.mjs", import.meta.url),
  "utf8",
);
const workflow = await readFile(
  new URL(
    "../../.github/workflows/ops-release-commercial-demo-blob-legal-holds.yml",
    import.meta.url,
  ),
  "utf8",
);

test("release operation is pinned to the approved exact manifest", () => {
  assert.match(source, /90a7217ff41c9530a738fc05b2e6b7bb759cf2a62ecc1e6a733398d45ff44483/);
  assert.match(source, /EXPECTED_JOBS = 24/);
  assert.match(source, /EXPECTED_KEYS = 68/);
  assert.match(source, /EXPECTED_VERSIONS = 69/);
  assert.match(source, /EXPECTED_CANDIDATES = 1519/);
  assert.match(source, /bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8/);
});

test("release is version-specific and never recursive or bucket-level", () => {
  assert.match(source, /PutObjectLegalHoldCommand/);
  assert.match(source, /VersionId: row\.versionId/);
  assert.match(source, /LegalHold: \{ Status: "OFF" \}/);
  assert.doesNotMatch(source, /PutObjectLockConfigurationCommand/);
  assert.doesNotMatch(source, /DeleteBucket/);
  assert.doesNotMatch(source, /--recursive/);
  assert.doesNotMatch(workflow, /legalhold clear/);
});

test("release preserves denylisted prefixes and writes audit intents before requeue", () => {
  assert.match(source, /tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ/);
  assert.match(source, /tenant_blob\.legal_hold_release_requested/);
  assert.match(source, /tenant_blob\.legal_hold_released/);
  assert.match(source, /tenant_blob\.purge_requeued_after_hold_release/);
  assert.ok(
    source.indexOf("enqueueReleaseRequested") < source.indexOf("clearAndVerifyHolds(manifest)"),
  );
  assert.match(source, /protected_prefixes_unchanged/);
});
