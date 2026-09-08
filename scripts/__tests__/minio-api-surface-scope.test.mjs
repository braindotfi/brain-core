import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const COMPOSE = readFileSync(join(ROOT, "docker-compose.prod.yml"), "utf8");
const POLICY = JSON.parse(
  readFileSync(join(ROOT, "infra/minio/brain-api-artifacts-v1.json"), "utf8"),
);
const PREPARE = join(ROOT, "scripts/ops/prepare-minio-api-env.sh");

function serviceBlock(name) {
  const match = COMPOSE.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)`, "m"),
  );
  assert.ok(match, `missing ${name} service`);
  return match[0];
}

test("API receives only its rendered scoped S3 credential", () => {
  const api = serviceBlock("api");
  const common = COMPOSE.match(/^x-brain-common-env:[\s\S]*?(?=^services:)/m)?.[0] ?? "";

  assert.match(api, /path: \.env\.api\.prod/);
  assert.match(api, /required: true/);
  assert.doesNotMatch(api, /MINIO_ROOT_USER|MINIO_ROOT_PASSWORD/);
  assert.doesNotMatch(api, /MINIO_API_ACCESS_KEY_ID|MINIO_API_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(api, /MINIO_WORKER_ACCESS_KEY_ID|MINIO_WORKER_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(common, /S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY/);
});

test("surface gateway receives no object-store identity", () => {
  const surface = serviceBlock("surface-gateway")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(
    surface,
    /S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|MINIO_API_|MINIO_WORKER_/,
  );
});

test("managed API setup applies the exact approved policy", () => {
  const setup = serviceBlock("minio-api-setup");
  assert.match(setup, /path: \.env\.minio-api/);
  assert.match(setup, /brain-api-artifacts-v1\.json/);
  assert.match(setup, /mc admin user add local/);
  assert.match(setup, /mc admin policy attach local brain-api-artifacts-v1/);
  assert.deepEqual(POLICY.Statement, [
    {
      Sid: "ApiArtifactAccess",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:PutObjectLegalHold", "s3:PutObjectTagging"],
      Resource: ["arn:aws:s3:::brain-artifacts/*"],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(POLICY),
    /s3:\*|ListBucket|DeleteObject|GetObjectLegalHold|GetObjectTagging|PutObjectRetention/,
  );
});

test("API env renderer removes root and all credential-source names", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-api-env-"));
  try {
    const source = join(root, ".env.prod");
    const credentials = join(root, ".env.minio-api");
    const output = join(root, ".env.api.prod");
    writeFileSync(
      source,
      [
        "MINIO_ROOT_USER=root-user",
        "MINIO_ROOT_PASSWORD=root-secret",
        "MINIO_WORKER_ACCESS_KEY_ID=brain-worker",
        "MINIO_WORKER_SECRET_ACCESS_KEY=worker-secret",
        "S3_ACCESS_KEY_ID=old-access",
        "S3_SECRET_ACCESS_KEY=old-secret",
        "BRAIN_SESSION_KEY=session-secret",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = execFileSync(
      "bash",
      [PREPARE, "--env", source, "--credentials", credentials, "--output", output],
      { encoding: "utf8" },
    );
    const rendered = readFileSync(output, "utf8");
    const credentialText = readFileSync(credentials, "utf8");

    assert.match(result, /api_credential_status=created_or_repaired/);
    assert.match(rendered, /BRAIN_SESSION_KEY=session-secret/);
    assert.match(rendered, /S3_ACCESS_KEY_ID=brain-api/);
    assert.match(rendered, /S3_SECRET_ACCESS_KEY=[0-9a-f]{64}/);
    assert.doesNotMatch(
      rendered,
      /MINIO_ROOT_|MINIO_API_|MINIO_WORKER_|old-access|old-secret|root-secret|worker-secret/,
    );
    assert.match(credentialText, /^MINIO_API_ACCESS_KEY_ID=brain-api$/m);
    assert.match(credentialText, /^MINIO_API_SECRET_ACCESS_KEY=[0-9a-f]{64}$/m);
    assert.equal(statSync(credentials).mode & 0o777, 0o600);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API env renderer refuses an unexpected managed access key", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-api-env-"));
  try {
    const source = join(root, ".env.prod");
    const credentials = join(root, ".env.minio-api");
    const output = join(root, ".env.api.prod");
    writeFileSync(source, "MINIO_ROOT_USER=root\nMINIO_ROOT_PASSWORD=secret\n", { mode: 0o600 });
    writeFileSync(
      credentials,
      "MINIO_API_ACCESS_KEY_ID=unexpected\nMINIO_API_SECRET_ACCESS_KEY=hidden\n",
      { mode: 0o600 },
    );
    chmodSync(credentials, 0o600);

    const result = spawnSync(
      "bash",
      [PREPARE, "--env", source, "--credentials", credentials, "--output", output],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /MINIO_API_ACCESS_KEY_ID_status=unexpected_value/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /hidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy workflows prepare and reconcile API identity before recreate", () => {
  for (const path of [".github/workflows/main.yml", ".github/workflows/promote-prod.yml"]) {
    const workflow = readFileSync(join(ROOT, path), "utf8");
    const prepareAt = workflow.indexOf("Prepare scoped MinIO API and worker environments");
    const reconcileAt = workflow.indexOf("Reconcile scoped MinIO API and worker identities");
    const recreateAt = workflow.indexOf("Recreate api/worker/agents/surface-gateway on VM");
    assert.ok(prepareAt > 0, `${path} must prepare the API env`);
    assert.ok(reconcileAt > prepareAt, `${path} must reconcile after preparing credentials`);
    assert.ok(recreateAt > reconcileAt, `${path} must reconcile before API recreation`);
    assert.match(workflow, /infra\/minio\/brain-api-artifacts-v1\.json/);
    assert.match(workflow, /scripts\/ops\/prepare-minio-api-env\.sh/);
  }
});

test("production verifier pins SHA, identities, root absence, and lifecycle", () => {
  const workflow = readFileSync(
    join(ROOT, ".github/workflows/ops-minio-api-surface-scope.yml"),
    "utf8",
  );
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /Exact deployed commit SHA to verify/);
  assert.match(workflow, /api_effective_identity=brain-api/);
  assert.match(workflow, /surface_object_store_identity=absent/);
  assert.match(workflow, /api_policy=brain-api-artifacts-v1/);
  assert.match(workflow, /verify-minio-api-lifecycle\.mjs/);

  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);
  assert.ok(remoteScriptMatch, "expected a fixed remote verification script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
