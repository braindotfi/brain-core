import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe.sequential;
const suffix = `${process.pid}_${Date.now()}`;

suite("x402 Phase 2 database contract", () => {
  let client: Client;
  const tenantId = `tnt_x402p2_${suffix}`;
  const keyId = `akey_x402p2_${suffix}`;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
    await client.query(
      `INSERT INTO api_keys (
         id, tenant_id, name, environment, scopes, key_prefix, key_last4,
         hashed_secret, credential_class, created_at, expires_at
       ) VALUES (
         $1, $2, 'x402 phase2 integration', 'sandbox', ARRAY['ledger:read'],
         'brain_xk_test_', 'test', $3, 'x402_pay_per_call', now(),
         now() + interval '30 days'
       )`,
      [keyId, tenantId, "a".repeat(64)],
    );
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.query("ROLLBACK");
    await client.end();
  });

  it("records the RFC 0008 receiver as permanently retired", async () => {
    const result = await client.query(
      `SELECT label, status, may_receive, may_sign
         FROM x402_seller_wallets
        WHERE id = 'x402wallet_rfc0008_retired'`,
    );
    expect(result.rows[0]).toEqual({
      label: "rfc0008_test_receiver_retired",
      status: "retired",
      may_receive: false,
      may_sign: false,
    });
    await client.query("SAVEPOINT retired_wallet");
    await expect(
      client.query(
        `UPDATE x402_seller_wallets SET may_receive = TRUE
          WHERE id = 'x402wallet_rfc0008_retired'`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT retired_wallet");
  });

  it("accepts only immutable grants for x402 credentials", async () => {
    const policy = await client.query<{ id: string }>(
      `SELECT id FROM x402_seller_operation_allowlist WHERE operation_id = 'listAccounts'`,
    );
    await client.query(
      `INSERT INTO x402_api_key_operation_grants (
         id, tenant_id, api_key_id, operation_policy_id, expires_at
       ) VALUES ($1, $2, $3, $4, now() + interval '29 days')`,
      [`x402grant_${suffix}`, tenantId, keyId, policy.rows[0]!.id],
    );
    await client.query("SAVEPOINT immutable_grant");
    await expect(
      client.query(
        `UPDATE x402_api_key_operation_grants SET expires_at = expires_at WHERE api_key_id = $1`,
        [keyId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT immutable_grant");
  });

  it("rejects grants to commercial-included keys", async () => {
    const commercialKey = `akey_commercial_${suffix}`;
    await client.query(
      `INSERT INTO api_keys (
         id, tenant_id, name, environment, scopes, key_prefix, key_last4,
         hashed_secret, credential_class
       ) VALUES (
         $1, $2, 'ordinary key', 'sandbox', ARRAY['ledger:read'],
         'brain_sk_test_', 'test', $3, 'commercial_included'
       )`,
      [commercialKey, tenantId, "b".repeat(64)],
    );
    const policy = await client.query<{ id: string }>(
      `SELECT id FROM x402_seller_operation_allowlist WHERE operation_id = 'listAccounts'`,
    );
    await client.query("SAVEPOINT wrong_class");
    await expect(
      client.query(
        `INSERT INTO x402_api_key_operation_grants (
           id, tenant_id, api_key_id, operation_policy_id, expires_at
         ) VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
        [`x402grant_wrong_${suffix}`, tenantId, commercialKey, policy.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await client.query("ROLLBACK TO SAVEPOINT wrong_class");
  });

  it("keeps counterfactual evidence append-only and separate", async () => {
    const policy = await client.query<{ id: string; price_policy_id: string }>(
      `SELECT id, api_price_policy_id AS price_policy_id
         FROM x402_seller_operation_allowlist WHERE operation_id = 'listAccounts'`,
    );
    await client.query(
      `INSERT INTO x402_counterfactual_observations (
         id, tenant_id, tenant_reference_sha256, operation_policy_id,
         request_digest, price_policy_id, allowance_outcome,
         quote_amount_atomic, facilitator_outcome, evidence_digest, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'over', 10000,
         'not_attempted', $7, now()
       )`,
      [
        `x402counter_${suffix}`,
        tenantId,
        "c".repeat(64),
        policy.rows[0]!.id,
        "d".repeat(64),
        policy.rows[0]!.price_policy_id,
        "e".repeat(64),
      ],
    );
    await client.query("SAVEPOINT immutable_counterfactual");
    await expect(
      client.query(`DELETE FROM x402_counterfactual_observations WHERE id = $1`, [
        `x402counter_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT immutable_counterfactual");
  });

  it("requires distinct Treasury and Security approvers", async () => {
    await client.query("SAVEPOINT same_approver");
    await expect(
      client.query(
        `INSERT INTO x402_sweep_destination_changes (
           id, environment, checksummed_address, manifest_digest, requested_at,
           treasury_approved_by, treasury_approved_at, security_approved_by,
           security_approved_at, effective_at, test_transfer_tx_hash,
           confirmation_phrase
         ) VALUES (
           $1, 'sandbox', '0x1111111111111111111111111111111111111111', $2, now(),
           'same-person', now(), 'same-person', now(), now(), $3,
           'APPROVE_X402_SWEEP_DESTINATION_CHANGE_NO_BYPASS'
         )`,
        [`x402dest_${suffix}`, "f".repeat(64), `0x${"a".repeat(64)}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT same_approver");
  });
});
