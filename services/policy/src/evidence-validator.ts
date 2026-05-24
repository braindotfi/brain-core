/**
 * H-21 evidence semantic validator — Policy-layer entry point.
 *
 * The pure validator lives in @brain/shared (shared/src/gate/evidence-validator.ts)
 * so the §6 gate can call it without a service dependency (the gate is in
 * `shared`; it must not import a service). This module re-exports it under the
 * path the hardening spec names, and is where the Policy layer's evidence rules
 * are extended.
 *
 * The DB enrichment — loading raw_parsed `extracted` payloads and resolving
 * invoice_number/amount_paid against ledger_invoices — is the gate's injected
 * `resolveEvidence` loader (see GateDependencies). That loader is DB-backed and
 * crosses into the Raw/Ledger read surface, so it is wired + verified in a
 * Postgres-capable environment, not here.
 */

export {
  validateEvidence,
  type EvidenceValidationInput,
  type EvidenceValidationResult,
  type ResolvedEvidence,
  type TrustLevel,
  type RiskLevel,
} from "@brain/shared";
