/**
 * Shared types referenced by every layer-boundary contract.
 *
 * These are wire-shape types, not implementation details. Mirror the
 * OpenAPI schema definitions in Brain_API_Specification.yaml.
 */

export type Provenance =
  | "extracted"
  | "inferred"
  | "ambiguous"
  | "human_confirmed"
  | "agent_contributed";

export type Currency = string; // ISO 4217 (BRL, USD, EUR, ...) or chain symbol (ETH, USDC, ...)

/** Decimal as a string. Never f64 — accounting requires exact arithmetic. */
export type DecimalString = string;

export interface LedgerCommonFields {
  id: string;
  owner_id: string;
  source_ids: string[];
  evidence_ids: string[];
  provenance: Provenance;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface PaginationCursor {
  cursor: string | null;
}

export interface ListResult<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ServiceCallContext {
  /** Tenant id derived from the JWT principal. Always required. */
  tenantId: string;
  /** Principal id of the caller — user, agent, or api_partner. */
  actor: string;
  /** Request id for tracing through audit events. */
  requestId?: string;
  /** Principal type from the JWT. Present on authenticated HTTP routes; absent on background workers. */
  principalType?: "user" | "agent" | "api_partner";
  /** Scopes granted by the JWT. Present on authenticated HTTP routes; absent on background workers. */
  scopes?: ReadonlyArray<string>;
}
