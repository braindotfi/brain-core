import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = process.cwd();
const workflow = readFileSync(
  join(root, ".github/workflows/ops-production-api-key-auth.yml"),
  "utf8",
);
const control = readFileSync(join(root, "scripts/ops/production-api-key-auth-control.sh"), "utf8");
const acceptance = readFileSync(join(root, "scripts/ops/production_api_key_acceptance.py"), "utf8");
const observation = readFileSync(
  join(root, "scripts/ops/observe-production-api-key-auth.py"),
  "utf8",
);

test("production API-key workflow exposes only fixed actions and exact confirmations", () => {
  assert.match(workflow, /action:\n\s+description:[\s\S]*?type: choice/);
  assert.match(workflow, /options:\n\s+- inspect\n\s+- enable\n\s+- disable/);
  assert.match(workflow, /INSPECT_PRODUCTION_API_KEY_AUTH/);
  assert.match(workflow, /ENABLE_PRODUCTION_API_KEY_AUTH/);
  assert.match(workflow, /DISABLE_PRODUCTION_API_KEY_AUTH/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: promote-prod/);
  assert.doesNotMatch(
    workflow,
    /inputs\.(?:host|env_file|compose_project|command|pepper|rate_limit)/,
  );
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
});

test("enablement transports the protected pepper only in mode-0600 files", () => {
  assert.match(workflow, /secrets\.BRAIN_API_KEY_PEPPER_PRODUCTION/);
  assert.doesNotMatch(workflow, /echo .*BRAIN_API_KEY_PEPPER_PRODUCTION/);
  assert.match(workflow, /chmod 600 "\$patch_file"/);
  assert.match(workflow, /install -m 600 \/dev\/null '\$REMOTE_DIR\/enable\.patch'/);
  assert.match(workflow, /chmod 600 '\$REMOTE_DIR\/enable\.patch'/);
  assert.match(workflow, /trap 'rm -f \\"\$REMOTE_DIR\/enable\.patch\\"' EXIT/);
  assert.match(control, /patch_mode_not_0600/);
  assert.match(control, /len\(pepper\) < 64/);
});

test("control script is production-bound, atomic, API-only, and preserves pepper on disable", () => {
  assert.match(control, /readonly API_BASE="https:\/\/api\.brain\.fi"/);
  assert.match(control, /readonly VM_ENV_FILE="\.env\.prod"/);
  assert.match(control, /readonly API_ENV_FILE="\.env\.api\.prod"/);
  assert.match(control, /readonly COMPOSE_PROJECT="brain-prod"/);
  assert.match(control, /os\.replace\(temporary, target\)/);
  assert.match(control, /--force-recreate api/);
  assert.doesNotMatch(control, /--force-recreate (?:worker|agents|surface-gateway)/);
  assert.doesNotMatch(control, /docker compose down/);
  assert.match(control, /BRAIN_API_KEY_AUTH_ENABLED=false/);
  assert.doesNotMatch(control, /BRAIN_API_KEY_PEPPER=(?:""|'')/);
  assert.match(control, /production_api_key_control_rollback=restored_and_verified/);
  assert.match(control, /migration_0017_shape_present/);
  assert.match(control, /rls_forced/);
  assert.match(control, /redis-cli ping/);
  assert.match(control, /prepare-minio-api-env\.sh/);
  assert.match(control, /scoped API MinIO identity is not brain-api/);
  assert.match(control, /credential file is not mode 0600/);
  assert.match(workflow, /--env-file ~\/brain-core\/\.env\.api\.prod/);
});

test("inspect avoids readonly assignment failures and reports commercial and role state", () => {
  assert.doesNotMatch(control, /(?:^|\n)\s*API_BASE="\$API_BASE" VM_ENV_FILE="\$VM_ENV_FILE"/);
  assert.match(control, /env API_BASE="\$API_BASE" VM_ENV_FILE="\$VM_ENV_FILE"/);
  assert.match(control, /production_commercial_flag_states/);
  assert.match(control, /BRAIN_PRODUCTION_GRADUATION_ENABLED/);
  assert.match(control, /BRAIN_COMMERCIAL_CATALOG_ENABLED/);
  assert.match(control, /BRAIN_STRIPE_BILLING_ENABLED/);
  assert.match(control, /BRAIN_X402_PAYMENTS_ENABLED/);
  assert.match(control, /commercial_flags_all_false/);
  assert.match(
    control,
    /has_table_privilege\(pg_roles\.oid, to_regclass\('public\.api_keys'\), 'SELECT'\)/,
  );
  assert.match(control, /LEFT JOIN pg_roles ON pg_roles\.rolname = role_names\.role_name/);
  assert.match(control, /'present', role_present/);
  assert.match(control, /role_grants_match/);
  assert.match(control, /role_name = 'brain_app'/);
  assert.match(control, /role_name = 'brain_tenant_deletion'/);
  assert.match(control, /if ! report_database_state; then passed=false; fi/);
  assert.match(control, /if ! require_redis; then passed=false; fi/);
  assert.match(control, /production_api_key_redis_state[^\n]+healthy[^\n]+false/);
  assert.match(control, /production_api_scoped_minio_state[^\n]+healthy[^\n]+false/);
  assert.match(control, /production_api_key_inspection=failed/);
});

test("acceptance exercises live reads, denial, metering, lifecycle, cleanup, and redaction", () => {
  assert.match(acceptance, /"environment": "live"/);
  assert.match(acceptance, /brain_sk_live_/);
  for (const scope of ["ledger:read", "audit:read", "governance:read"]) {
    assert.match(acceptance, new RegExp(scope.replace(":", "\\:")));
  }
  assert.match(acceptance, /\/ledger\/accounts/);
  assert.match(acceptance, /\/audit\/events\?limit=10/);
  assert.match(acceptance, /\/governance\/agents\?limit=10/);
  assert.match(acceptance, /\/authz\/probes\/payment-intent-approve/);
  assert.match(acceptance, /auth_scope_insufficient/);
  assert.match(acceptance, /environment=live&key_id=/);
  assert.match(acceptance, /\/rotate/);
  assert.match(acceptance, /auth_invalid_key/);
  assert.match(acceptance, /"DELETE"[\s\S]*\/tenants\//);
  assert.match(acceptance, /\/provenance/);
  assert.match(acceptance, /tenant_cleanup_verified/);
  assert.match(acceptance, /verify_container_log_redaction/);
  assert.match(acceptance, /workflow_artifact_uploads": 0/);
});

test("observation window is fixed at 30 minutes and covers the agreed signals", () => {
  assert.match(observation, /OBSERVATION_SECONDS = 30 \* 60/);
  assert.match(observation, /SAMPLE_SECONDS = 30/);
  assert.match(observation, /restart_count/);
  assert.match(observation, /auth_invalid_key_records/);
  assert.match(observation, /auth_scope_insufficient_records/);
  assert.match(observation, /rate_limited_records/);
  assert.match(observation, /redis_error_records/);
  assert.match(observation, /monitored_4xx/);
  assert.match(observation, /monitored_5xx/);
  assert.match(observation, /per_minute/);
  assert.match(observation, /api_key_shape_matches/);
  assert.match(observation, /api_key\.issued/);
  assert.match(observation, /api_key\.rotated/);
  assert.match(observation, /api_key\.revoked/);
});

test("operator programs parse cleanly", () => {
  const shell = spawnSync("bash", ["-n", "scripts/ops/production-api-key-auth-control.sh"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(shell.status, 0, shell.stderr);

  for (const file of [
    "scripts/ops/production_api_key_acceptance.py",
    "scripts/ops/observe-production-api-key-auth.py",
  ]) {
    const python = spawnSync(
      "python3",
      ["-c", "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", file],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(python.status, 0, python.stderr);
  }
});
