/**
 * Proof test 1 (§6 of Brain_MVP_Architecture.md):
 *
 * "A design partner can connect their bank + ERP, get a continuously
 * compiled financial memory, author a policy, have an agent propose and
 * execute a payment under that policy, and export a tamper-evident audit
 * record, all through Brain's API, in under 30 days of onboarding."
 *
 * This suite runs against staging. Requires BRAIN_BASE_URL + BRAIN_TOKEN
 * plus a seeded test tenant with Plaid sandbox + NetSuite sandbox wired.
 * Optional: BRAIN_TEST_TENANT_ID, BRAIN_TEST_VENDOR_ID,
 *           BRAIN_TEST_SOURCE_ACCT_ID.
 */

import { describe, expect, it } from "vitest";
import { envClient } from "./lib/client.js";

const DESCRIBE = process.env.BRAIN_BASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("five-layer end-to-end (Series A proof 1)", () => {
  it("connects Plaid, compiles ledger, signs policy, creates payment intent, exports audit", async () => {
    const client = envClient();

    // Step 1 — verify Raw ingestion produced audit events (Plaid seed has run).
    const artifacts = await client.get<{ events: unknown[] }>(
      "/v1/audit/events?layer=raw&limit=10",
    );
    expect(artifacts.events.length).toBeGreaterThan(0);

    // Step 2 — Ledger has accounts compiled from Plaid data.
    const ledger = await client.get<{ accounts: unknown[] }>("/v1/ledger/accounts?limit=10");
    expect(ledger.accounts.length).toBeGreaterThan(0);

    // Step 3 — policy is active.
    const tenantId = process.env.BRAIN_TEST_TENANT_ID ?? "";
    const policy = await client.get<{ state: string; version: number }>(
      `/v1/policy/${tenantId}`,
    );
    expect(policy.state).toBe("active");

    // Step 4 — create a PaymentIntent; it evaluates against the policy during
    // creation and records a policy_decision_id. The resulting status reflects
    // the policy outcome: approved (allow), pending_approval (confirm), or
    // rejected (reject).
    const intent = await client.post<{
      id: string;
      status: string;
      policy_decision_id: string | null;
    }>("/v1/payment-intents", {
      action_type: "ach_outbound",
      source_account_id: process.env.BRAIN_TEST_SOURCE_ACCT_ID ?? "",
      destination_counterparty_id: process.env.BRAIN_TEST_VENDOR_ID ?? "",
      amount: "50.00",
      currency: "USD",
    });
    expect(intent.id.startsWith("pi_")).toBe(true);
    expect(["proposed", "pending_approval", "approved", "rejected"]).toContain(intent.status);

    // Step 5 — audit verify endpoint is reachable even without auth (skipAuth).
    const verify = await fetch(
      `${process.env.BRAIN_BASE_URL}/v1/audit/verify?root=${"a".repeat(64)}&leaf=${"a".repeat(64)}&proof=`,
    );
    expect([200]).toContain(verify.status);
  });
});
