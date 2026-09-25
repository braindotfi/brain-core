import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const UPSTREAM_SERVER_IMAGE =
  "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const UPSTREAM_CLIENT_IMAGE =
  "quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z@sha256:c0d345a438dcac5677c1158e4ac46637069b67b3cc38e7b04c08cf93bdee4a62";
const CI_SERVER_IMAGE =
  "ghcr.io/braindotfi/mirror-minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const CI_CLIENT_IMAGE =
  "ghcr.io/braindotfi/mirror-minio-mc:RELEASE.2024-10-08T09-37-26Z@sha256:c0d345a438dcac5677c1158e4ac46637069b67b3cc38e7b04c08cf93bdee4a62";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const imageDigest = (value) => value.split("@")[1];

test("production MinIO images use verified Quay pins", () => {
  const compose = readFileSync("docker-compose.prod.yml", "utf8");

  assert.match(compose, new RegExp(escapeRegExp(UPSTREAM_SERVER_IMAGE)));
  assert.equal(compose.split(UPSTREAM_CLIENT_IMAGE).length - 1, 3);
});

test("integration MinIO fixture pulls GHCR mirror pins", () => {
  const integrationHarness = readFileSync(
    "scripts/ci/start-minio-worker-policy-test.sh",
    "utf8",
  );

  assert.match(integrationHarness, new RegExp(escapeRegExp(CI_SERVER_IMAGE)));
  assert.match(integrationHarness, new RegExp(escapeRegExp(CI_CLIENT_IMAGE)));
  assert.doesNotMatch(integrationHarness, /quay\.io\/minio\/minio:/);
});

test("CI mirror pins preserve upstream digests", () => {
  assert.equal(imageDigest(CI_SERVER_IMAGE), imageDigest(UPSTREAM_SERVER_IMAGE));
  assert.equal(imageDigest(CI_CLIENT_IMAGE), imageDigest(UPSTREAM_CLIENT_IMAGE));
});

test("mirror workflow copies Docker Hub sources by digest", () => {
  const workflow = readFileSync(".github/workflows/mirror-minio-ci-images.yml", "utf8");

  assert.match(workflow, /SERVER_UPSTREAM: docker\.io\/minio\/minio@sha256:/);
  assert.match(workflow, /CLIENT_UPSTREAM: docker\.io\/minio\/mc@sha256:/);
  assert.match(workflow, /DOCKERHUB_USERNAME/);
  assert.match(workflow, /DOCKERHUB_TOKEN/);
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
