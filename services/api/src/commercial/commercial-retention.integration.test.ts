import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe.sequential;
const suffix = `${process.pid}_${Date.now()}`;

suite("commercial financial retention database contract", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.query("ROLLBACK");
    await client.end();
  });

  async function seedAppliedStripeEvent(label: string, eventType = "invoice.paid") {
    const tenantId = `tnt_retention_${label}_${suffix}`;
    const billingId = `cba_retention_${label}_${suffix}`;
    const eventId = `cse_retention_${label}_${suffix}`;
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO commercial_billing_accounts (id, status, billing_currency, created_by)
       VALUES ($1, 'closed', 'USD', 'retention-integration')`,
      [billingId],
    );
    await client.query(
      `INSERT INTO commercial_billing_account_tenants
         (tenant_id, billing_account_id, relationship)
       VALUES ($1, $2, 'production')`,
      [tenantId, billingId],
    );
    await client.query(
      `INSERT INTO commercial_stripe_events (
         id, tenant_id, billing_account_id, provider_mode, stripe_event_id,
         event_type, event_created_at, payload, status, applied_at
       ) VALUES ($1, $2, $3, 'test', $4, $5, now(), $6::jsonb, 'applied', now())`,
      [
        eventId,
        tenantId,
        billingId,
        `evt_${label}_${suffix}`,
        eventType,
        JSON.stringify({
          data: {
            object: {
              id: `in_${label}`,
              amount_paid: 1200,
              currency: "usd",
              customer_email: "must-not-survive@example.invalid",
            },
          },
          client_secret: "must-not-survive",
        }),
      ],
    );
    return { tenantId, billingId, eventId };
  }

  async function retireFixture(tenantId: string, receiptId: string): Promise<string> {
    const prepared = await client.query<{ subject_id: string }>(
      `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
      [tenantId, receiptId],
    );
    const subjectId = prepared.rows[0]?.subject_id;
    if (subjectId === undefined) throw new Error("retention subject missing");
    await client.query(`DELETE FROM commercial_billing_account_tenants WHERE tenant_id = $1`, [
      tenantId,
    ]);
    await client.query(`DELETE FROM commercial_stripe_events WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    return subjectId;
  }

  it("erases the tenant while retaining only minimized HMAC-linked evidence", async () => {
    const fixture = await seedAppliedStripeEvent("success");
    const receiptId = `retreceipt_success_${suffix}`;
    const subjectId = await retireFixture(fixture.tenantId, receiptId);

    expect(
      (await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [fixture.tenantId])).rowCount,
    ).toBe(0);
    const subject = await client.query<{
      former_tenant_digest: string;
      retirement_receipt_id: string;
    }>(
      `SELECT former_tenant_digest, retirement_receipt_id
         FROM commercial_retention_subjects WHERE id = $1`,
      [subjectId],
    );
    expect(subject.rows[0]).toMatchObject({ retirement_receipt_id: receiptId });
    expect(subject.rows[0]?.former_tenant_digest).toMatch(/^[0-9a-f]{64}$/);

    const retained = await client.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM commercial_retained_stripe_events WHERE source_row_id = $1`,
      [fixture.eventId],
    );
    expect(retained.rows[0]?.evidence).toMatchObject({
      event_type: "invoice.paid",
      amount_paid: "1200",
      currency: "usd",
    });
    const serialized = JSON.stringify(retained.rows[0]?.evidence);
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("customer_email");
    expect(serialized).not.toContain("client_secret");

    await client.query("SAVEPOINT retention_immutable");
    await expect(
      client.query(
        `UPDATE commercial_retained_stripe_events SET evidence = '{}'::jsonb WHERE source_row_id = $1`,
        [fixture.eventId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK TO SAVEPOINT retention_immutable");
  });

  it("requires preparation before direct commercial source or tenant deletion", async () => {
    await client.query("SAVEPOINT direct_delete_guard");
    const fixture = await seedAppliedStripeEvent("direct_delete");
    await expect(
      client.query(`DELETE FROM commercial_stripe_events WHERE id = $1`, [fixture.eventId]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT direct_delete_guard");

    const second = await seedAppliedStripeEvent("direct_tenant");
    await expect(
      client.query(`DELETE FROM tenants WHERE id = $1`, [second.tenantId]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT direct_delete_guard");
  });

  it("fails closed for unknown events and unsettled provider commands", async () => {
    await client.query("SAVEPOINT unknown_extractor");
    const unknown = await seedAppliedStripeEvent("unknown", "future.event.not_classified");
    await expect(
      client.query(`SELECT prepare_commercial_financial_retention($1, $2)`, [
        unknown.tenantId,
        `retreceipt_unknown_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT unknown_extractor");

    const tenantId = `tnt_retention_unsettled_${suffix}`;
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO commercial_provider_commands (
         id, tenant_id, provider, provider_mode, command_type, idempotency_key,
         request_envelope, status
       ) VALUES ($1, $2, 'stripe', 'test', 'catalog.apply', $3, '{}', 'pending')`,
      [`pcmd_retention_${suffix}`, tenantId, `idem_${suffix}`],
    );
    await expect(
      client.query(`SELECT prepare_commercial_financial_retention($1, $2)`, [
        tenantId,
        `retreceipt_unsettled_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT unknown_extractor");

    const settlementTenantId = `tnt_retention_settlement_${suffix}`;
    const pricePolicy = await client.query<{ id: string }>(
      `SELECT id FROM x402_operation_price_policies ORDER BY id LIMIT 1`,
    );
    expect(pricePolicy.rows[0]?.id).toBeDefined();
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [settlementTenantId]);
    await client.query(
      `INSERT INTO x402_payment_operations (
         id, tenant_id, environment, operation_class, operation_id,
         logical_operation_id, price_policy_id, quote_digest, network,
         amount_atomic, quote_expires_at, facilitator_status,
         l2_inclusion_status, l1_inclusion_status, fulfillment_status
       ) VALUES (
         $1, $2, 'sandbox', 'api', 'audit.events.list', $3, $4, $5,
         'eip155:84532', 1000, now() + interval '1 minute', 'verified',
         'not_checked', 'not_checked', 'pending'
       )`,
      [
        `x402op_retention_${suffix}`,
        settlementTenantId,
        `logical_retention_${suffix}`,
        pricePolicy.rows[0]?.id,
        "b".repeat(64),
      ],
    );
    await expect(
      client.query(`SELECT prepare_commercial_financial_retention($1, $2)`, [
        settlementTenantId,
        `retreceipt_settlement_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT unknown_extractor");
  });

  it("extracts every supported Stripe event type with its pinned schema version", async () => {
    await client.query("SAVEPOINT stripe_event_matrix");
    const eventTypes = [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "checkout.session.completed",
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.voided",
      "invoice.marked_uncollectible",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.closed",
    ];
    const tenantId = `tnt_retention_stripe_matrix_${suffix}`;
    const billingId = `cba_retention_stripe_matrix_${suffix}`;
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO commercial_billing_accounts (id, status, billing_currency, created_by)
       VALUES ($1, 'closed', 'USD', 'retention-integration')`,
      [billingId],
    );
    await client.query(
      `INSERT INTO commercial_billing_account_tenants
         (tenant_id, billing_account_id, relationship)
       VALUES ($1, $2, 'production')`,
      [tenantId, billingId],
    );
    for (const [index, eventType] of eventTypes.entries()) {
      await client.query(
        `INSERT INTO commercial_stripe_events (
           id, tenant_id, billing_account_id, provider_mode, stripe_event_id,
           event_type, event_created_at, payload, status, applied_at
         ) VALUES ($1, $2, $3, 'test', $4, $5, now(), '{}', 'applied', now())`,
        [
          `cse_retention_matrix_${index}_${suffix}`,
          tenantId,
          billingId,
          `evt_matrix_${index}_${suffix}`,
          eventType,
        ],
      );
    }
    const prepared = await client.query<{ subject_id: string }>(
      `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
      [tenantId, `retreceipt_stripe_matrix_${suffix}`],
    );
    const archived = await client.query<{ event_type: string; schema_version: number }>(
      `SELECT evidence->>'event_type' AS event_type, schema_version
         FROM commercial_retained_stripe_events
        WHERE retention_subject_id = $1
        ORDER BY event_type`,
      [prepared.rows[0]?.subject_id],
    );
    expect(archived.rows).toEqual(
      eventTypes
        .map((eventType) => ({ event_type: eventType, schema_version: 1 }))
        .sort((left, right) => left.event_type.localeCompare(right.event_type)),
    );
    await client.query("ROLLBACK TO SAVEPOINT stripe_event_matrix");
  });

  it("serializes a concurrent provider write behind the retirement seal", async () => {
    const retiring = new Client({ connectionString: databaseUrl });
    const provider = new Client({ connectionString: databaseUrl });
    const tenantId = `tnt_retention_lock_${suffix}`;
    const receiptId = `retreceipt_lock_${suffix}`;
    let transactionOpen = false;
    let subjectId: string | undefined;
    await retiring.connect();
    await provider.connect();
    try {
      await retiring.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
      await retiring.query("BEGIN");
      transactionOpen = true;
      const prepared = await retiring.query<{ subject_id: string }>(
        `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
        [tenantId, receiptId],
      );
      subjectId = prepared.rows[0]?.subject_id;
      expect(subjectId).toBeDefined();

      let lateWriteSettled = false;
      const lateWrite = provider
        .query(
          `INSERT INTO commercial_stripe_events (
             id, tenant_id, provider_mode, stripe_event_id, event_type,
             event_created_at, payload, status, applied_at
           ) VALUES ($1, $2, 'test', $3, 'invoice.paid', now(), '{}', 'applied', now())`,
          [`cse_retention_lock_${suffix}`, tenantId, `evt_lock_${suffix}`],
        )
        .then(
          () => {
            lateWriteSettled = true;
            return { ok: true as const, code: undefined };
          },
          (error: unknown) => {
            lateWriteSettled = true;
            return { ok: false as const, code: (error as { code?: string }).code };
          },
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lateWriteSettled).toBe(false);

      await retiring.query("COMMIT");
      transactionOpen = false;
      expect(await lateWrite).toEqual({ ok: false, code: "55000" });

      await retiring.query("BEGIN");
      transactionOpen = true;
      await retiring.query(
        `SELECT set_config('app.commercial_retention_purge', 'authorized', true)`,
      );
      await retiring.query(
        `UPDATE commercial_retention_receipts
            SET prepared_txid = txid_current()
          WHERE id = $1`,
        [receiptId],
      );
      await retiring.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await retiring.query(
        `UPDATE commercial_retention_subjects
            SET retired_at = now() - interval '8 years',
                retain_until = now() - interval '1 second'
          WHERE id = $1`,
        [subjectId],
      );
      await retiring.query(
        `SELECT purge_expired_commercial_retention(
           $1, $2, 'integration-cleanup', 'PURGE_EXPIRED_COMMERCIAL_RETENTION'
         )`,
        [subjectId, "c".repeat(64)],
      );
      await retiring.query(
        `DELETE FROM commercial_retention_purge_receipts WHERE retention_subject_id = $1`,
        [subjectId],
      );
      await retiring.query("COMMIT");
      transactionOpen = false;
    } finally {
      if (transactionOpen) await retiring.query("ROLLBACK");
      await retiring.end();
      await provider.end();
    }
  });

  it("minimizes the complete x402 seller graph and erases its operational rows", async () => {
    await client.query("SAVEPOINT x402_graph");
    const tenantId = `tnt_retention_x402_${suffix}`;
    const logicalId = `x402log_retention_${suffix}`;
    const quoteId = `x402quote_retention_${suffix}`;
    const receiptId = `x402receipt_retention_${suffix}`;
    const nonceDigest = "d".repeat(64);
    const paymentDigest = "e".repeat(64);
    const policies = await client.query<{ operation_policy_id: string; price_policy_id: string }>(
      `SELECT operation.id AS operation_policy_id, price.id AS price_policy_id
         FROM x402_seller_operation_allowlist operation
         JOIN x402_operation_price_policies price
           ON price.id = COALESCE(operation.api_price_policy_id, operation.mcp_price_policy_id)
        ORDER BY operation.id, price.id LIMIT 1`,
    );
    expect(policies.rows[0]).toBeDefined();
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO x402_seller_logical_operations (
         id, tenant_id, tenant_reference_sha256, operation_policy_id,
         environment, request_digest, state
       ) VALUES ($1, $2, $3, $4, 'sandbox', $5, 'fulfilled')`,
      [logicalId, tenantId, "a".repeat(64), policies.rows[0]?.operation_policy_id, "b".repeat(64)],
    );
    await client.query(
      `INSERT INTO x402_seller_quotes (
         id, logical_operation_id, price_policy_id, quote_digest, nonce_digest,
         protocol_version, scheme, network, asset_contract, recipient_address,
         amount_atomic, quoted_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 2, 'exact', 'eip155:84532', $6, $7,
         1000, now() - interval '2 minutes', now() - interval '1 minute'
       )`,
      [
        quoteId,
        logicalId,
        policies.rows[0]?.price_policy_id,
        "c".repeat(64),
        nonceDigest,
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
    );
    await client.query(
      `INSERT INTO x402_seller_nonce_consumptions (
         nonce_digest, quote_id, payment_payload_digest
       ) VALUES ($1, $2, $3)`,
      [nonceDigest, quoteId, paymentDigest],
    );
    await client.query(
      `INSERT INTO x402_seller_receipts (
         id, tenant_id, tenant_reference_sha256, logical_operation_id, quote_id,
         payment_payload_digest, state, payer_address, settlement_tx_hash,
         l2_finality, l1_finality
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'fulfilled', $7, $8, 'sealed', 'included'
       )`,
      [
        receiptId,
        tenantId,
        "a".repeat(64),
        logicalId,
        quoteId,
        paymentDigest,
        "0xprivate-payer-address",
        `0x${"f".repeat(64)}`,
      ],
    );
    await client.query(
      `INSERT INTO x402_seller_settlement_events (
         id, receipt_id, sequence, event_kind, transaction_hash,
         evidence_digest, evidence, occurred_at
       ) VALUES ($1, $2, 1, 'fulfilled', $3, $4, $5::jsonb, now())`,
      [
        `x402event_retention_${suffix}`,
        receiptId,
        `0x${"f".repeat(64)}`,
        "1".repeat(64),
        JSON.stringify({ customer_email: "must-not-survive@example.invalid", secret: "hidden" }),
      ],
    );

    const subjectId = await retireFixture(tenantId, `retreceipt_x402_${suffix}`);
    const retainedOperations = await client.query<{
      source_table: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT source_table, evidence FROM commercial_retained_x402_operations
        WHERE retention_subject_id = $1 ORDER BY source_table`,
      [subjectId],
    );
    expect(retainedOperations.rows.map((row) => row.source_table)).toEqual([
      "x402_seller_logical_operations",
      "x402_seller_nonce_consumptions",
      "x402_seller_quotes",
      "x402_seller_receipts",
    ]);
    expect(JSON.stringify(retainedOperations.rows)).not.toContain("private-payer-address");
    const retainedEvent = await client.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM commercial_retained_x402_events WHERE retention_subject_id = $1`,
      [subjectId],
    );
    expect(retainedEvent.rows[0]?.evidence).toMatchObject({
      event_kind: "fulfilled",
      provider_evidence_digest: "1".repeat(64),
    });
    expect(JSON.stringify(retainedEvent.rows[0]?.evidence)).not.toContain("must-not-survive");
    for (const table of [
      "x402_seller_settlement_events",
      "x402_seller_nonce_consumptions",
      "x402_seller_receipts",
      "x402_seller_quotes",
      "x402_seller_logical_operations",
    ]) {
      expect((await client.query(`SELECT 1 FROM ${table} WHERE true`)).rowCount).toBe(0);
    }
    await client.query("ROLLBACK TO SAVEPOINT x402_graph");
  });

  it("retains only a digest of a versioned provider request envelope", async () => {
    await client.query("SAVEPOINT provider_minimization");
    const tenantId = `tnt_retention_provider_${suffix}`;
    const commandId = `pcmd_retention_provider_${suffix}`;
    await client.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await client.query(
      `INSERT INTO commercial_retention_extractor_registry
         (source_table, source_kind, schema_version)
       VALUES ('commercial_provider_commands', 'stripe:catalog.apply', 1)`,
    );
    await client.query(
      `INSERT INTO commercial_provider_commands (
         id, tenant_id, provider, provider_mode, command_type, idempotency_key,
         request_envelope, status, provider_reference
       ) VALUES ($1, $2, 'stripe', 'test', 'catalog.apply', $3, $4::jsonb,
                 'succeeded', 'req_safe')`,
      [
        commandId,
        tenantId,
        `idem_provider_${suffix}`,
        JSON.stringify({
          api_secret: "must-not-survive",
          customer_email: "private@example.invalid",
        }),
      ],
    );
    const subject = await client.query<{ subject_id: string }>(
      `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
      [tenantId, `retreceipt_provider_${suffix}`],
    );
    const retained = await client.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM commercial_retained_provider_commands
        WHERE retention_subject_id = $1 AND source_row_id = $2`,
      [subject.rows[0]?.subject_id, commandId],
    );
    expect(retained.rows[0]?.evidence).toMatchObject({
      command_type: "catalog.apply",
      provider: "stripe",
      provider_reference: "req_safe",
    });
    expect(retained.rows[0]?.evidence.request_envelope_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(retained.rows[0]?.evidence)).not.toContain("must-not-survive");
    expect(JSON.stringify(retained.rows[0]?.evidence)).not.toContain("private@example.invalid");
    await client.query("ROLLBACK TO SAVEPOINT provider_minimization");
  });

  it("detects an archive count mismatch and rolls back every retained row", async () => {
    await client.query("SAVEPOINT mismatch");
    const fixture = await seedAppliedStripeEvent("mismatch");
    await client.query(`
      CREATE FUNCTION pg_temp.drop_retained_stripe_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER test_drop_retained_stripe_event
      BEFORE INSERT ON commercial_retained_stripe_events
      FOR EACH ROW EXECUTE FUNCTION pg_temp.drop_retained_stripe_event()
    `);
    await expect(
      client.query(`SELECT prepare_commercial_financial_retention($1, $2)`, [
        fixture.tenantId,
        `retreceipt_mismatch_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT mismatch");
    expect(
      (
        await client.query(
          `SELECT 1 FROM commercial_retention_subjects WHERE retirement_receipt_id = $1`,
          [`retreceipt_mismatch_${suffix}`],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("is idempotent for one receipt and rejects a different receipt", async () => {
    await client.query("SAVEPOINT idempotency");
    const fixture = await seedAppliedStripeEvent("idempotency");
    const receipt = `retreceipt_idempotency_${suffix}`;
    const first = await client.query<{ subject_id: string }>(
      `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
      [fixture.tenantId, receipt],
    );
    const second = await client.query<{ subject_id: string }>(
      `SELECT prepare_commercial_financial_retention($1, $2) AS subject_id`,
      [fixture.tenantId, receipt],
    );
    expect(second.rows[0]?.subject_id).toBe(first.rows[0]?.subject_id);
    await expect(
      client.query(`SELECT prepare_commercial_financial_retention($1, $2)`, [
        fixture.tenantId,
        `retreceipt_different_${suffix}`,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT idempotency");
  });

  it("denies expiry on legal hold and preserves a non-sensitive purge receipt", async () => {
    await client.query("SAVEPOINT expiry");
    const fixture = await seedAppliedStripeEvent("expiry");
    const receipt = `retreceipt_expiry_${suffix}`;
    const subjectId = await retireFixture(fixture.tenantId, receipt);
    await client.query(`SELECT set_config('app.commercial_retention_purge', 'authorized', true)`);
    await client.query(
      `UPDATE commercial_retention_subjects
          SET retired_at = now() - interval '8 years', retain_until = now() - interval '1 second'
        WHERE id = $1`,
      [subjectId],
    );
    const boundary = await client.query<{
      before: boolean;
      exact: boolean;
      after: boolean;
    }>(
      `SELECT
         commercial_retention_expiry_eligible($1, retain_until - interval '1 microsecond') AS before,
         commercial_retention_expiry_eligible($1, retain_until) AS exact,
         commercial_retention_expiry_eligible($1, retain_until + interval '1 microsecond') AS after
       FROM commercial_retention_subjects WHERE id = $1`,
      [subjectId],
    );
    expect(boundary.rows[0]).toEqual({ before: false, exact: false, after: true });
    await client.query(
      `SELECT set_commercial_retention_legal_hold($1, true, $2, 'integration-test')`,
      [subjectId, "Active litigation retention hold"],
    );
    await client.query("SAVEPOINT held_purge");
    await expect(
      client.query(`SELECT purge_expired_commercial_retention($1, $2, $3, $4)`, [
        subjectId,
        "a".repeat(64),
        "integration-test",
        "PURGE_EXPIRED_COMMERCIAL_RETENTION",
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT held_purge");
    await client.query(
      `SELECT set_commercial_retention_legal_hold($1, false, $2, 'integration-test')`,
      [subjectId, "Reviewed legal hold release"],
    );
    const purged = await client.query<{ purge_id: string }>(
      `SELECT purge_expired_commercial_retention($1, $2, $3, $4) AS purge_id`,
      [subjectId, "a".repeat(64), "integration-test", "PURGE_EXPIRED_COMMERCIAL_RETENTION"],
    );
    expect(purged.rows[0]?.purge_id).toMatch(/^retpurge_[0-9a-f]{32}$/);
    expect(
      (await client.query(`SELECT 1 FROM commercial_retention_subjects WHERE id = $1`, [subjectId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT 1 FROM commercial_retention_purge_receipts
            WHERE retention_subject_id = $1 AND manifest_digest = $2`,
          [subjectId, "a".repeat(64)],
        )
      ).rowCount,
    ).toBe(1);
    await client.query("ROLLBACK TO SAVEPOINT expiry");
  });
});
