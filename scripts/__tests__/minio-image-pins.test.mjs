import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SERVER_IMAGE =
  "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const CLIENT_IMAGE =
  "quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z@sha256:c0d345a438dcac5677c1158e4ac46637069b67b3cc38e7b04c08cf93bdee4a62";

test("production and integration MinIO images use verified Quay pins", () => {
  const compose = readFileSync("docker-compose.prod.yml", "utf8");
  const integrationHarness = readFileSync(
    "scripts/ci/start-minio-worker-policy-test.sh",
    "utf8",
  );

  assert.match(compose, new RegExp(SERVER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(compose.split(CLIENT_IMAGE).length - 1, 3);
  assert.match(
    integrationHarness,
    new RegExp(SERVER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    integrationHarness,
    new RegExp(CLIENT_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("active MinIO operations do not reference archived Docker Hub images", () => {
  for (const path of [
    "docker-compose.prod.yml",
    "scripts/ci/start-minio-worker-policy-test.sh",
    ".github/workflows/ops-minio-worker-scope.yml",
    ".github/workflows/ops-minio-api-surface-scope.yml",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /(^|[\s"'])minio\/(?:minio|mc):/m, path);
  }
});
