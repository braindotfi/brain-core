/**
 * Finch payroll parser validation for the canonical connector cutover.
 *
 * `finch_payroll_v1` rows are retained and validated here, but the connector no
 * longer writes Ledger rows directly. Canonical projection now owns employee,
 * payroll obligation, and payroll transaction promotion.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

export async function normalizeFinchArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError(
      "ledger_row_invalid",
      "finch_payroll_v1: payload must carry object_type and objects",
    );
  }
  return [];
}
