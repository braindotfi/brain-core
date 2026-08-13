import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/staging-diagnostics.yml");

test("staging tenant identity lookup is fixed, validated, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /tenant-identity-lookup/);
  assert.match(workflow, /Exact platform user UUID or email/);
  assert.match(workflow, /requires an exact UUID or email/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /member_identity_links l/);
  assert.match(workflow, /tenant\.created', 'tenant\.demo_seeded/);
  assert.match(workflow, /^ {10}SQL$/m);
  assert.match(workflow, /^ {10}REMOTE$/m);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});

test("counterparty trust impact report classifies rows through the read-only diagnostics role", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /docker exec -i brain-prod-postgres psql -U brain -d brain/);
  assert.match(workflow, /JOIN tenants t ON t\.id = cp\.owner_id/);
  assert.match(workflow, /t\.kind AS tenant_kind/);
  assert.match(workflow, /t\.sandbox/);
  assert.match(workflow, /t\.created_via/);
  assert.match(workflow, /t\.kind = 'production' AND t\.sandbox = FALSE/);
  assert.match(workflow, /non_demo_review_groups/);
  assert.match(workflow, /demo_or_sandbox_groups/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY/);
  assert.match(workflow, /SET LOCAL statement_timeout = '5s';/);
  assert.match(workflow, /^ {10}SQL$/m);
  assert.match(workflow, /^ {10}REMOTE$/m);
  assert.doesNotMatch(workflow, /REPORT_SCRIPT/);
});

test("staging Wiki question trace is tenant-bounded, selector-bounded, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /wiki-question-trace/);
  assert.match(workflow, /requires exactly one canonical tenant id/);
  assert.match(workflow, /requires an event id, timestamp bound, or question search/);
  assert.match(workflow, /wiki_question_search must be 160 characters or less/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /action = 'wiki\.question'/);
  assert.match(workflow, /inputs->>'question' ILIKE/);
  assert.match(workflow, /LIMIT 20;/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
});

test("trust-gate smoke audit reconciliation is fixed, bounded, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /trust-gate-smoke-audit-reconciliation/);
  assert.match(workflow, /connection role and RLS posture/);
  assert.match(workflow, /current_setting\('app\.tenant_id', true\)/);
  assert.match(workflow, /API database target, redacted/);
  assert.match(workflow, /direct PostgreSQL target/);
  assert.match(workflow, /tnt_01KZW834C21D22K32NEE79FWQE/);
  assert.match(workflow, /durable payment intents for the original smoke tenant/);
  assert.match(workflow, /tenant-scoped API audit response for the original smoke tenant/);
  assert.match(workflow, /scopes: \["audit:read"\]/);
  assert.match(workflow, /ae\.action = 'payment_intent\.execute\.after'/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /SET LOCAL statement_timeout = '5s';/);
  assert.match(workflow, /SET LOCAL lock_timeout = '1s';/);
});

test("prior controlled-smoke execution diagnostic is fixed and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /trust-gate-prior-smoke-execution/);
  assert.match(workflow, /tnt_01KZX2QQZVES2W2Y05AJHKCGQ0/);
  assert.match(workflow, /prior controlled-smoke tenant payment intents/);
  assert.match(workflow, /prior controlled-smoke tenant outbox rows and terminal state/);
  assert.match(workflow, /prior controlled-smoke tenant execution receipts/);
  assert.match(workflow, /prior controlled-smoke tenant execution audit events/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /SET LOCAL statement_timeout = '5s';/);
  assert.match(workflow, /SET LOCAL lock_timeout = '1s';/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
});

test("trust-gate observation is fixed, staging-only, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /trust-gate-24h-observation/);
  assert.match(workflow, /trust_gate_observation_since/);
  assert.match(workflow, /requires an exact ISO UTC start bound/);
  assert.match(workflow, /api_trust_gate_enabled=/);
  assert.match(workflow, /worker_trust_gate_enabled=/);
  assert.match(workflow, /counterparty_trust_unknown_count/);
  assert.match(workflow, /counterparty_trust_paused events with pause attribution/);
  assert.match(workflow, /counterparty\.trust\.paused/);
  assert.match(workflow, /normal payment execution outcomes/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /SET LOCAL statement_timeout = '5s';/);
  assert.match(workflow, /SET LOCAL lock_timeout = '1s';/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
});

test("staging diagnostic nested heredocs close at their owning handler", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const identityStart = workflow.indexOf("run_tenant_identity_lookup() {");
  const reconciliationStart = workflow.indexOf("run_trust_gate_smoke_audit_reconciliation() {");
  const wikiStart = workflow.indexOf("run_wiki_question_trace() {");

  assert.ok(
    identityStart >= 0 && reconciliationStart > identityStart && wikiStart > reconciliationStart,
  );
  const identityHandler = workflow.slice(identityStart, reconciliationStart);
  const reconciliationHandler = workflow.slice(reconciliationStart, wikiStart);

  assert.match(identityHandler, /SQL\n\s+REMOTE\n\s+\}/);
  assert.match(reconciliationHandler, /SQL[\s\S]*REMOTE\n\s+\}/);
  assert.match(reconciliationHandler, /<<'REMOTE'/);
  assert.match(reconciliationHandler, /docker exec -w \/app\/services\/api -e SMOKE_TENANT_ID/);
  assert.doesNotMatch(reconciliationHandler, /docker exec -i brain-prod-postgres psql[^\n]*-c/);
  assert.doesNotMatch(reconciliationHandler, /-c \\\"SELECT/);
});
