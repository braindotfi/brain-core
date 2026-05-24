/**
 * §6 gate check 11.5 — duplicate-payment guard types (H-22).
 *
 * "Brain will not pay an invoice twice" is a deterministic property of the gate.
 * The detector that runs these rules is DB-backed and lives in services/policy
 * (duplicate-detector.ts); the gate consumes it through the injected
 * `detectDuplicates` GateDependencies hook. These shared types are the contract
 * between the two (the gate is in `shared` and must not import a service).
 */

export interface DuplicateCheckInput {
  readonly tenantId: string;
  readonly paymentIntent: {
    id: string;
    counterpartyId: string;
    amount: string; // decimal-string
    currency: string;
    invoiceId?: string;
    obligationId?: string;
    /** raw_artifact ids referenced as evidence. */
    evidenceArtifactIds: ReadonlyArray<string>;
  };
}

export interface DuplicateCollision {
  rule: string;
  detail: string;
  conflicting_payment_intent_id?: string;
}

export interface DuplicateCheckResult {
  passed: boolean;
  collisions: ReadonlyArray<DuplicateCollision>;
}
