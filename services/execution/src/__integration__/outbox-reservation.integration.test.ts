/**
 * Real-DB regression for the reservation id carried by execution_outbox.
 *
 * Requires a migrated Postgres via DATABASE_URL; skipped otherwise. Unit tests
 * prove PaymentIntentService and the worker forward reservationId correctly.
 * This test catches schema/query drift in the durable outbox table itself.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  newLedgerReservationId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newTenantId,
  withTenantScope,
} from "@brain/shared";
import { OutboxService } from "../outbox/OutboxService.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("execution outbox reservation persistence (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();
  const paymentIntentId = newPaymentIntentId();
  const policyDecisionId = newPolicyDecisionId();
  const reservationId = newLedgerReservationId();
  const outbox = new OutboxService();
  let outboxId: string | undefined;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await withTenantScope(pool, tenant, async (c) => {
      await c.query(`DELETE FROM execution_outbox WHERE tenant_id = $1`, [tenant]);
    });
    await pool.end();
  });

  it("stores reservation_id on enqueue and preserves it through terminal row writes", async () => {
    const idempotencyKey = `pi:${paymentIntentId}:${policyDecisionId}`;
    const enqueued = await withTenantScope(pool, tenant, (c) =>
      outbox.enqueue(c, tenant, {
        paymentIntentId,
        rail: "bank_ach",
        idempotencyKey,
        payload: {
          kind: "ach_outbound",
          source_account_id: "acct_integration",
          destination_counterparty_id: "cp_integration",
          amount: "100.00",
          currency: "USD",
        },
        auditBeforeId: "evt_integration_before",
        reservationId,
      }),
    );
    outboxId = enqueued.id;

    const pending = await readOutboxRow();
    expect(pending).toMatchObject({
      payment_intent_id: paymentIntentId,
      status: "pending",
      reservation_id: reservationId,
    });

    await withTenantScope(pool, tenant, (c) =>
      outbox.markDispatched(c, enqueued.id, {
        railReceipt: { rail: "ach", ach_trace: "trace_integration" },
        auditAfterId: "evt_integration_after",
        executionId: "exec_integration",
      }),
    );
    await withTenantScope(pool, tenant, (c) => outbox.markSettled(c, enqueued.id));

    const settled = await readOutboxRow();
    expect(settled).toMatchObject({
      status: "settled",
      reservation_id: reservationId,
      execution_id: "exec_integration",
    });
  });

  async function readOutboxRow(): Promise<{
    payment_intent_id: string;
    status: string;
    reservation_id: string | null;
    execution_id: string | null;
  }> {
    if (outboxId === undefined) throw new Error("outbox row was not enqueued");
    return await withTenantScope(pool, tenant, async (c) => {
      const { rows } = await c.query<{
        payment_intent_id: string;
        status: string;
        reservation_id: string | null;
        execution_id: string | null;
      }>(
        `SELECT payment_intent_id, status, reservation_id, execution_id
           FROM execution_outbox WHERE id = $1`,
        [outboxId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("execution_outbox row not found");
      return row;
    });
  }
});
