/**
 * Typed rail receipts (Agent Autonomy v3, 2.4).
 *
 * Each rail returns a receipt with a rail-specific shape. The §6 audit-after
 * step refuses to commit unless the receipt validates against the schema for the
 * rail used — so the forensic record (replay-investigation) is always complete
 * and typed. Canonical JSON Schemas live in schemas/rail-receipts/.
 */

export type RailReceipt =
  | { rail: "ach"; ach_trace: string; return_code?: string }
  | { rail: "wire"; omad: string; imad: string }
  | { rail: "erp"; erp_record_id: string; vendor_ref?: string }
  | {
      rail: "onchain";
      tx_hash: string;
      block_number: number;
      revert_reason?: string;
      gas_used?: string;
      nonce?: string;
      policy_version?: string;
    };

export type RailReceiptKey = RailReceipt["rail"];

/** Required fields per rail receipt (mirrors schemas/rail-receipts/*.json). */
const REQUIRED_FIELDS: Record<RailReceiptKey, readonly string[]> = {
  ach: ["ach_trace"],
  wire: ["omad", "imad"],
  erp: ["erp_record_id"],
  onchain: ["tx_hash", "block_number"],
};

/** Map a PaymentIntent action_type to its receipt rail key, or null if untyped. */
export function railKeyForActionType(actionType: string): RailReceiptKey | null {
  if (actionType.startsWith("ach")) return "ach";
  if (actionType === "wire") return "wire";
  if (actionType === "erp_writeback") return "erp";
  if (actionType === "onchain_transfer") return "onchain";
  return null; // card_payment / notification: no typed receipt schema
}

export interface RailReceiptValidation {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/**
 * Structurally validate a rail receipt against the required fields for `railKey`.
 * An unknown rail key (no schema) is treated as ok (nothing to enforce).
 */
export function validateRailReceipt(
  railKey: RailReceiptKey | null,
  receipt: Record<string, unknown>,
): RailReceiptValidation {
  if (railKey === null) {
    return { ok: true, missing: [] };
  }
  const required = REQUIRED_FIELDS[railKey];
  const missing = required.filter((f) => {
    const v = receipt[f];
    return v === undefined || v === null || v === "";
  });
  // block_number must be a number when present.
  if (railKey === "onchain" && receipt.block_number !== undefined) {
    if (typeof receipt.block_number !== "number") {
      return { ok: false, missing: [...missing, "block_number(number)"] };
    }
  }
  return { ok: missing.length === 0, missing };
}
