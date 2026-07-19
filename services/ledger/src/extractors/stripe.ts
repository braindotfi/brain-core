/**
 * Stripe parser validation for the canonical connector cutover.
 *
 * `stripe_v1` rows no longer write accounts, transactions, counterparties, or
 * obligations directly to Ledger. The canonical projector owns that promotion
 * and Ledger projects from canonical. This extractor stays registered so the
 * normalize worker validates parser shape and then returns no rows.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw brainError("ledger_row_invalid", `stripe amount is not integer minor units: ${cents}`);
  }
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

export async function normalizeStripeArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError("ledger_row_invalid", "stripe_v1: payload must carry object_type and objects");
  }
  return [];
}
