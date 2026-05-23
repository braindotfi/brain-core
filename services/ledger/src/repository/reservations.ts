/**
 * ledger_reservations repository (Agent Autonomy v3, 1b.1). Tenant-scoped.
 *
 * A reservation holds a slice of an account's available balance during the §6
 * gate window so parallel money-movers can't double-spend the same balance.
 * Lifecycle: active → consumed (on execution) | released (rail failure/cancel) |
 * expired (TTL lapse, swept nightly).
 */

import type { TenantScopedClient } from "@brain/shared";

export type ReservationStatus = "active" | "consumed" | "released" | "expired";

export interface ReservationRow {
  id: string;
  owner_id: string;
  account_id: string;
  amount: string;
  currency: string;
  payment_intent_id: string;
  policy_decision_id: string;
  reserving_agent_id: string;
  reserved_until: Date;
  status: ReservationStatus;
  created_at: Date;
}

export interface InsertReservationInput {
  id: string;
  ownerId: string;
  accountId: string;
  amount: string;
  currency: string;
  paymentIntentId: string;
  policyDecisionId: string;
  reservingAgentId: string;
  /** Defaults to now() + 60s when omitted. */
  reservedUntil?: Date;
}

export async function insertReservation(
  client: TenantScopedClient,
  input: InsertReservationInput,
): Promise<ReservationRow> {
  const { rows } = await client.query<ReservationRow>(
    `INSERT INTO ledger_reservations (
       id, owner_id, account_id, amount, currency, payment_intent_id,
       policy_decision_id, reserving_agent_id, reserved_until, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now() + interval '60 seconds'),'active')
     RETURNING *`,
    [
      input.id,
      input.ownerId,
      input.accountId,
      input.amount,
      input.currency,
      input.paymentIntentId,
      input.policyDecisionId,
      input.reservingAgentId,
      input.reservedUntil ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("ledger_reservations insert returned no row");
  return row;
}

/**
 * Sum of currently-active, non-expired reservations against an account, as a
 * decimal string. Gate check #8 subtracts this from available_balance.
 */
export async function sumActiveReservations(
  client: TenantScopedClient,
  accountId: string,
): Promise<string> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM ledger_reservations
      WHERE account_id = $1 AND status = 'active' AND reserved_until > now()`,
    [accountId],
  );
  return rows[0]?.total ?? "0";
}

async function transition(
  client: TenantScopedClient,
  id: string,
  to: ReservationStatus,
): Promise<void> {
  await client.query(
    `UPDATE ledger_reservations SET status = $1 WHERE id = $2 AND status = 'active'`,
    [to, id],
  );
}

/** Mark a reservation consumed (its PaymentIntent executed). */
export function consumeReservation(client: TenantScopedClient, id: string): Promise<void> {
  return transition(client, id, "consumed");
}

/** Release a reservation (rail failure / cancel) so its balance frees up. */
export function releaseReservation(client: TenantScopedClient, id: string): Promise<void> {
  return transition(client, id, "released");
}

/**
 * Expire active reservations past their TTL. Returns the count expired. Run by
 * the nightly sweep; also safe to call opportunistically.
 */
export async function expireDueReservations(client: TenantScopedClient): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE ledger_reservations SET status = 'expired'
      WHERE status = 'active' AND reserved_until <= now()`,
  );
  return rowCount ?? 0;
}
