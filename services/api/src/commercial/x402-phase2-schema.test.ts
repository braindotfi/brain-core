import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0049_x402_wallet_credentials_and_adapter.sql"),
  "utf8",
);

describe("x402 Phase 2 schema", () => {
  it("retires the RFC 0008 receiver and cannot authorize it", () => {
    expect(migration).toContain("rfc0008_test_receiver_retired");
    expect(migration).toContain("0x5e22088C527e2C112dbe47ceADca94db9Aa19497");
    expect(migration).toMatch(/'retired_external', 'retired', FALSE, FALSE/);
    expect(migration).toContain("x402 wallet registry permits only one-way retirement");
  });

  it("binds pay-per-call credentials immutably to the fixed six operations", () => {
    expect(migration).toContain("CREATE TABLE x402_api_key_operation_grants");
    expect(migration).toContain("credential_class <> 'x402_pay_per_call'");
    expect(migration).toContain("key_prefix NOT IN ('brain_xk_test_', 'brain_xk_live_')");
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain("interval '90 days'");
    expect(
      migration.match(
        /'listAccounts'|'listTransactions'|'listAuditEvents'|'ledger\.accounts\.list'|'ledger\.transactions\.list'|'ledger\.obligations\.list'/g,
      ),
    ).toHaveLength(6);
    expect(migration).toContain("x402_api_key_grants_immutable");
    expect(migration).toContain("BEFORE UPDATE ON x402_api_key_operation_grants");
  });

  it("uses separate append-only counterfactual and capability evidence", () => {
    expect(migration).toContain("CREATE TABLE x402_counterfactual_observations");
    expect(migration).toContain("CREATE TABLE x402_cdp_capability_witnesses");
    expect(migration).toContain("x402_counterfactual_observations_immutable");
    expect(migration).toContain("x402_cdp_witnesses_immutable");
    expect(migration).toContain("interval '7 years'");
  });

  it("requires two distinct humans, a test transfer, and a live delay", () => {
    expect(migration).toContain("treasury_approved_by <> security_approved_by");
    expect(migration).toContain("test_transfer_tx_hash TEXT        NOT NULL");
    expect(migration).toContain("interval '24 hours'");
    expect(migration).toContain("APPROVE_X402_SWEEP_DESTINATION_CHANGE_NO_BYPASS");
  });
});
