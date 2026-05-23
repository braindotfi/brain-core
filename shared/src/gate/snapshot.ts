/**
 * Gate-time ledger-state snapshot (§6 check 7.5 binding).
 *
 * Hashes the security-relevant ledger state the gate resolves at execute time —
 * the source account (status, currency, available balance) and the destination
 * counterparty (type, risk level, verification status). The gate records this
 * hash on the audit-before event and the GateResult, giving a tamper-evident,
 * verifiable record of the exact state money moved against (consumed by the
 * Proof API). It does not gate execution: the dangerous state deltas (sanctions,
 * lost verification, insufficient balance) are already rejected by checks 5/6/8,
 * which re-evaluate against this same current state.
 *
 * Canonical form: recursively key-sorted JSON with decimal-normalized balances,
 * so the hash is stable across representation drift. keccak is not required here
 * (this hash is off-chain audit metadata, not an on-chain Merkle leaf).
 */

import { createHash } from "node:crypto";

export interface LedgerStateInput {
  account: {
    id: string;
    status: string;
    currency: string;
    available_balance: string | null;
  };
  counterparty: {
    id: string;
    type: string;
    risk_level: string | null;
    verified_status: string | null;
  };
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** Canonical decimal string so "100.00" and "100" hash identically. */
function normalizeDecimal(s: string): string {
  let str = s.trim();
  const negative = str.startsWith("-");
  if (negative) str = str.slice(1);
  const [intRaw, fracRaw = ""] = str.split(".");
  const int = (intRaw ?? "").replace(/^0+/, "") || "0";
  const frac = fracRaw.replace(/0+$/, "");
  const body = frac.length > 0 ? `${int}.${frac}` : int;
  return negative && body !== "0" ? `-${body}` : body;
}

export function computeLedgerSnapshot(state: LedgerStateInput): string {
  const canonical = canonicalize({
    account: {
      id: state.account.id,
      status: state.account.status,
      currency: state.account.currency,
      available_balance:
        state.account.available_balance === null
          ? null
          : normalizeDecimal(state.account.available_balance),
    },
    counterparty: {
      id: state.counterparty.id,
      type: state.counterparty.type,
      risk_level: state.counterparty.risk_level,
      verified_status: state.counterparty.verified_status,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}
