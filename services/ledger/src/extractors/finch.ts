/**
 * Finch extractor (scaffolded): interprets `finch_v1` raw_parsed rows.
 *
 * TODO(connector): map the payload to Ledger entities through the
 * provenance-validating writers in ../service/writes.ts. Keep provider-only
 * fields in namespaced extensions; set provenance per the trust contract
 * (structured provider data => "extracted"; documents => "agent_contributed";
 * generic push => "customer_asserted").
 */

import type { Pool } from "pg";
import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

export async function normalizeFinchArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  _input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  // Skeleton: lands nothing until the mapping is implemented. Artifacts stay
  // retained in Raw and replay through this parser once it is real.
  return [];
}
