/**
 * Real-DB regression for ledger_reservations.
 *
 * Requires a migrated Postgres via DATABASE_URL; skipped otherwise. Unit tests
 * assert SQL shape, while this verifies NUMERIC storage, expiry filtering, and
 * active -> consumed/released transitions against the real table.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  newAccountId,
  newAgentId,
  newLedgerReservationId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newTenantId,
  withTenantScope,
} from "@brain/shared";
import { LedgerReservations } from "../reservations-facade.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("ledger reservations integration (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = newTenantId();

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await withTenantScope(pool, tenant, async (c) => {
      await c.query(`DELETE FROM ledger_reservations WHERE owner_id = $1`, [tenant]);
    });
    await pool.end();
  });

  it("sums active non-expired holds and removes consumed/released reservations", async () => {
    const accountId = newAccountId();
    const agentId = newAgentId();
    const first = newLedgerReservationId();
    const second = newLedgerReservationId();
    const expired = newLedgerReservationId();

    await withTenantScope(pool, tenant, async (c) => {
      await LedgerReservations.insert(c, {
        id: first,
        ownerId: tenant,
        accountId,
        amount: "100.00",
        currency: "USD",
        paymentIntentId: newPaymentIntentId(),
        policyDecisionId: newPolicyDecisionId(),
        reservingAgentId: agentId,
        reservedUntil: new Date(Date.now() + 60_000),
      });
      await LedgerReservations.insert(c, {
        id: second,
        ownerId: tenant,
        accountId,
        amount: "200.00",
        currency: "USD",
        paymentIntentId: newPaymentIntentId(),
        policyDecisionId: newPolicyDecisionId(),
        reservingAgentId: agentId,
        reservedUntil: new Date(Date.now() + 60_000),
      });
      await LedgerReservations.insert(c, {
        id: expired,
        ownerId: tenant,
        accountId,
        amount: "999.00",
        currency: "USD",
        paymentIntentId: newPaymentIntentId(),
        policyDecisionId: newPolicyDecisionId(),
        reservingAgentId: agentId,
        reservedUntil: new Date(Date.now() - 60_000),
      });
    });

    await expect(activeTotal(accountId)).resolves.toBe(300);

    await withTenantScope(pool, tenant, (c) => LedgerReservations.consume(c, first));
    await expect(activeTotal(accountId)).resolves.toBe(200);

    await withTenantScope(pool, tenant, (c) => LedgerReservations.release(c, second));
    await expect(activeTotal(accountId)).resolves.toBe(0);
  });

  async function activeTotal(accountId: string): Promise<number> {
    return await withTenantScope(pool, tenant, async (c) =>
      Number(await LedgerReservations.sumActive(c, accountId)),
    );
  }
});
