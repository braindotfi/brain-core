/**
 * ledger_reservations repository (Agent Autonomy v3, 1b.1). Tenant-scoped.
 *
 * A reservation holds a slice of an account's available balance from durable
 * handoff until the money path reaches a terminal state. The §6 gate reads the
 * active total as a preflight; reserveIfAvailable is the authoritative writer
 * and serializes handoff per source account.
 * Lifecycle: active → consumed (on execution) | released (rail failure/cancel) |
 * expired (stale operational sweep).
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
  /** Defaults to now() + 24h when omitted; active rows still count until terminal. */
  reservedUntil?: Date;
}

export type ReserveIfAvailableFailureReason =
  | "account_not_found"
  | "account_inactive"
  | "currency_mismatch"
  | "available_balance_missing"
  | "insufficient_balance";

export type ReserveIfAvailableResult =
  | {
      ok: true;
      reservation: ReservationRow;
      availableBalance: string;
      reserved: string;
      required: string;
    }
  | {
      ok: false;
      reason: ReserveIfAvailableFailureReason;
      availableBalance?: string | null;
      reserved?: string;
      required?: string;
      accountStatus?: string;
      accountCurrency?: string;
      intentCurrency?: string;
    };

export async function insertReservation(
  client: TenantScopedClient,
  input: InsertReservationInput,
): Promise<ReservationRow> {
  const { rows } = await client.query<ReservationRow>(
    `INSERT INTO ledger_reservations (
       id, owner_id, account_id, amount, currency, payment_intent_id,
       policy_decision_id, reserving_agent_id, reserved_until, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now() + interval '24 hours'),'active')
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
 * Authoritative account-level reservation writer.
 *
 * This helper must run inside the same tenant transaction that moves a
 * PaymentIntent to dispatching and enqueues the outbox row. It locks the source
 * account row, locks the latest balance snapshot when present, re-reads active
 * reservations, and only then inserts the new active reservation. Because every
 * live writer uses the same account row lock, concurrent handoffs serialize and
 * cannot both reserve the same available funds.
 */
export async function reserveIfAvailable(
  client: TenantScopedClient,
  input: InsertReservationInput,
): Promise<ReserveIfAvailableResult> {
  const accountRes = await client.query<{
    id: string;
    status: string;
    currency: string;
    available_balance: string | null;
  }>(
    `SELECT id, status, currency, available_balance::text AS available_balance
       FROM ledger_accounts
      WHERE id = $1
      FOR UPDATE`,
    [input.accountId],
  );
  const account = accountRes.rows[0];
  if (account === undefined) return { ok: false, reason: "account_not_found" };
  if (account.status !== "active") {
    return { ok: false, reason: "account_inactive", accountStatus: account.status };
  }

  const balanceRes = await client.query<{
    currency: string;
    available_balance: string | null;
  }>(
    `SELECT currency, available_balance::text AS available_balance
       FROM ledger_balances
      WHERE account_id = $1
      ORDER BY as_of DESC
      LIMIT 1
      FOR UPDATE`,
    [input.accountId],
  );
  const latestBalance = balanceRes.rows[0] ?? null;
  const accountCurrency = latestBalance?.currency ?? account.currency;
  const availableBalance = latestBalance?.available_balance ?? account.available_balance;

  if (accountCurrency !== input.currency) {
    return {
      ok: false,
      reason: "currency_mismatch",
      accountCurrency,
      intentCurrency: input.currency,
    };
  }
  if (availableBalance === null) {
    return { ok: false, reason: "available_balance_missing", availableBalance };
  }

  const reserved = await sumActiveReservations(client, input.accountId);
  const required = addDecimalString(input.amount, reserved);
  if (cmpDecimal(availableBalance, required) < 0) {
    return {
      ok: false,
      reason: "insufficient_balance",
      availableBalance,
      reserved,
      required,
    };
  }

  return {
    ok: true,
    reservation: await insertReservation(client, input),
    availableBalance,
    reserved,
    required,
  };
}

/**
 * Sum of currently-active reservations against an account, as a decimal string.
 * Gate check #8 subtracts this from available_balance. Active rows are counted
 * until explicitly consumed/released/expired; reserved_until is an operational
 * stale-row marker, not a settlement hold boundary.
 */
export async function sumActiveReservations(
  client: TenantScopedClient,
  accountId: string,
): Promise<string> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM ledger_reservations
      WHERE account_id = $1 AND status = 'active'`,
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

function cmpDecimal(a: string, b: string): number {
  const sa = toScaled8(a);
  const sb = toScaled8(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function addDecimalString(a: string, b: string): string {
  const sum = toScaled8(a) + toScaled8(b);
  const raw = sum.toString().padStart(9, "0");
  const intPart = raw.slice(0, raw.length - 8).replace(/^0+/, "") || "0";
  const fracPart = raw.slice(raw.length - 8).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

function toScaled8(s: string): bigint {
  const trimmed = s.trim();
  if (trimmed.startsWith("-")) throw new Error("reservation decimal must be non-negative");
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const frac = (fracPart + "00000000").slice(0, 8);
  return BigInt((intPart === "" ? "0" : intPart.replace(/^0+/, "") || "0") + frac);
}
