import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ops-agent-key-extractor-canary.yml");
const canary = read("scripts/ops/cutover-document-extractor-agent-key.sh");
const mainWorkflow = read(".github/workflows/main.yml");
const promoteWorkflow = read(".github/workflows/promote-prod.yml");

test("agent images and deploy gates bind the running extractor to the exact SHA", () => {
  assert.match(
    mainWorkflow,
    /docker build --build-arg GIT_SHA=\$\{\{ github\.sha \}\} -t ghcr\.io\/braindotfi\/brain-agents:/,
  );
  assert.match(mainWorkflow, /docker exec brain-prod-agents printenv GIT_SHA/);
  assert.match(mainWorkflow, /actual" = "\$expected/);
  assert.match(promoteWorkflow, /docker exec brain-prod-agents printenv GIT_SHA/);
  assert.match(promoteWorkflow, /actual" = "\$expected/);
});

test("canary is exact-SHA gated and migrates only the document extractor", () => {
  assert.match(workflow, /inputs\.sha/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(canary, /document_extractor_v1/);
  assert.match(canary, /--force-recreate agents/);
  assert.doesNotMatch(canary, /--force-recreate .*worker/);
  assert.doesNotMatch(canary, /--force-recreate .*surface-gateway/);
});

test("canary proves the actual runtime key, claims, scope ceiling, and lifecycle", () => {
  assert.match(canary, /printenv BRAIN_API_TOKEN/);
  assert.match(canary, /legacy_runtime_source_match=true/);
  assert.match(canary, /AGENT_KEY_ENVIRONMENT" == "test/);
  assert.match(canary, /staging_fixture_binding=created_or_preserved/);
  assert.match(canary, /agent_database_binding_status=active_internal/);
  assert.match(canary, /docker exec -i brain-prod-postgres/);
  assert.match(canary, /test -z "\$\{BRAIN_API_TOKEN\+x\}"/);
  assert.match(canary, /runtime_agent_key_match=true/);
  assert.match(canary, /credential_id/);
  assert.match(canary, /ttl > 300/);
  assert.match(canary, /raw_read_denial_status=403/);
  assert.match(canary, /\/v1\/raw\/ingest/);
  assert.match(canary, /\/extract/);
  assert.match(canary, /--data-binary '\{"retry":true\}'/);
  assert.match(canary, /extraction_retry_mode=fresh_attempt/);
  assert.match(
    canary,
    /state="\$\(docker exec -i brain-prod-postgres psql[\s\S]*FROM extraction_jobs j/,
  );
  assert.match(canary, /FROM extraction_jobs j/);
  assert.match(canary, /value\.api_key/);
  assert.match(canary, /oauth\.agent_api_key\.exchanged/);
  assert.match(canary, /canary_status=confirmed/);
});

test("failed cutover restores the legacy runtime and leaves retirement untouched", () => {
  assert.match(canary, /canary_failure_diagnostics=begin/);
  assert.match(canary, /docker logs --since 30m brain-prod-agents/);
  assert.match(canary, /redacted_credential/);
  assert.match(canary, /redacted_openai_key/);
  assert.match(canary, /tail -240/);
  assert.match(canary, /failed_restoring_legacy_runtime/);
  assert.match(canary, /BRAIN_AGENTS_AUTH_MODE legacy_jwt/);
  assert.match(canary, /legacy_jwt_revoked=false/);
  assert.match(canary, /agent_token_route_retired=false/);
  assert.doesNotMatch(canary, /revokeProductionAgentTokens|DELETE FROM production_agent_tokens/);
});
