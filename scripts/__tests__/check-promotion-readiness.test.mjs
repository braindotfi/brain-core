import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runReadinessChecks } from "../check-promotion-readiness.mjs";

/** Build a synthetic repo with the files a fully-ready "savings" agent needs. */
function readyFixture(overrides = {}) {
  const files = {
    "services/execution/migrations/0017_execution_outbox.sql":
      "CREATE TABLE execution_outbox (...);\nALTER TABLE execution_outbox ENABLE ROW LEVEL SECURITY;",
    "services/ledger/src/repository/reservations.test.ts": 'it("concurrent reservation", () => {});',
    "services/policy/src/spend-counters.test.ts": 'it("window rollover", () => {});',
    "services/agent-router/src/promotion-config.ts":
      'export const LIVE_AGENTS = { liveAgents: { savings: ["ach"] } };',
    "services/execution/src/rails/receipts.ts": 'const REQUIRED = { "ach": ["ach_trace"] };',
    "shared/src/gate/gate.ts": 'pass(checks, 11.5, "no_duplicate_payment");',
    "shared/src/gate/evidence-validator.ts": 'const RULES = { pay_invoice: [], pay_obligation: [] };',
    "tests/invariants/src/invariants.test.ts": "// emits audit-before via gate AND audit-after",
    "services/execution/src/payment-intents/routes.ts": 'app.get("/payment-intents/:id/replay-investigation", h);',
    "services/agent-router/src/agent-api.test.ts": 'it("halt-category stops all agents", () => {});',
    "tests/invariants/agents/savings.test.ts": 'it("savings adversarial", () => {});',
    ...overrides,
  };
  const dir = mkdtempSync(join(tmpdir(), "promo-ready-"));
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue; // omit this file
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function rowById(rows, id) {
  return rows.find((r) => r.id === id);
}

test("all green when every static file is present and out-of-band checks are attested", () => {
  const dir = readyFixture();
  const { rows, allOk } = runReadinessChecks({
    repo: dir,
    agent: "savings",
    attest: ["onchain_behavior_hash", "session_key_grants"],
  });
  assert.equal(allOk, true, JSON.stringify(rows.filter((r) => !r.ok), null, 2));
  rmSync(dir, { recursive: true, force: true });
});

test("fails when the execution outbox migration / RLS is missing", () => {
  const dir = readyFixture({ "services/execution/migrations/0017_execution_outbox.sql": null });
  const { rows, allOk } = runReadinessChecks({ repo: dir, agent: "savings", attest: ["onchain_behavior_hash", "session_key_grants"] });
  assert.equal(allOk, false);
  assert.equal(rowById(rows, "outbox_rls").ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("fails when the agent has no rail allowlist in promotion-config.ts", () => {
  const dir = readyFixture({
    "services/agent-router/src/promotion-config.ts": "export const LIVE_AGENTS = { liveAgents: {} };",
  });
  const { rows } = runReadinessChecks({ repo: dir, agent: "savings", attest: ["onchain_behavior_hash", "session_key_grants"] });
  assert.equal(rowById(rows, "rail_allowlist").ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("flags a missing typed receipt schema for an allowlisted rail", () => {
  const dir = readyFixture({
    "services/agent-router/src/promotion-config.ts":
      'export const LIVE_AGENTS = { liveAgents: { savings: ["wire"] } };',
    // receipts.ts only defines "ach", not "wire"
  });
  const { rows } = runReadinessChecks({ repo: dir, agent: "savings", attest: ["onchain_behavior_hash", "session_key_grants"] });
  assert.equal(rowById(rows, "typed_rail_receipt").ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("out-of-band checks are BLOCKED (not pass) without attestation", () => {
  const dir = readyFixture();
  const { rows, allOk } = runReadinessChecks({ repo: dir, agent: "savings", attest: [] });
  assert.equal(allOk, false);
  const onchain = rowById(rows, "onchain_behavior_hash");
  assert.equal(onchain.ok, false);
  assert.equal(onchain.blocked, true);
  assert.equal(rowById(rows, "session_key_grants").blocked, true);
  rmSync(dir, { recursive: true, force: true });
});

test("the §6 gate checks (9.5 + 11.5) and evidence validator are detected", () => {
  const dir = readyFixture();
  const { rows } = runReadinessChecks({ repo: dir, agent: "savings", attest: [] });
  assert.equal(rowById(rows, "dedup_gate_check").ok, true);
  assert.equal(rowById(rows, "evidence_validator").ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("fails when adversarial agent coverage is absent", () => {
  const dir = readyFixture({ "tests/invariants/agents/savings.test.ts": null });
  const { rows } = runReadinessChecks({ repo: dir, agent: "savings", attest: ["onchain_behavior_hash", "session_key_grants"] });
  assert.equal(rowById(rows, "adversarial_agent_tests").ok, false);
  rmSync(dir, { recursive: true, force: true });
});
