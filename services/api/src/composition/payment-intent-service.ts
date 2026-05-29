/**
 * Single PaymentIntentService factory used at every route mount in this
 * binary. Centralizing construction means there is only one shape to keep in
 * sync with the §6 gate's expected deps. Composition-root parity drift was
 * the most expensive class of bug we shipped before this; the
 * check-payment-intent-loaders lint reads from this factory's call sites
 * and refuses any production code path that constructs the service inline.
 */

import {
  PaymentIntentService,
  OutboxService,
  type ApprovalService,
  type OnchainDispatchParams,
} from "@brain/execution";
import type {
  AuditEmitter,
  ServiceCallContext,
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePrincipal,
  GateTenantFlags,
  AgentAttestationInput,
  AgentAttestationResult,
  EscrowStateInput,
  ResolvedEscrowState,
  ResolvedEvidence,
  DuplicateCheckInput,
  DuplicateCheckResult,
  MetricsEmitter,
} from "@brain/shared";
import type { Pool } from "pg";
import type { PaymentIntentPolicyEvaluator } from "@brain/execution";

/**
 * The full shape of dependencies a production PaymentIntentService must
 * receive. Optional fields are still expected in prod; absent values cause
 * the corresponding §6 gate check to degrade to `not_applicable`, which the
 * composition-root parity lint catches at CI time.
 */
export interface BuildPaymentIntentServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  approvals: ApprovalService;

  resolveAgent: (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null>;
  resolveAccount: (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null>;
  resolveCounterparty: (
    ctx: ServiceCallContext,
    counterpartyId: string,
  ) => Promise<GateCounterparty | null>;
  resolvePrincipal: (ctx: ServiceCallContext) => Promise<GatePrincipal>;
  evaluatePolicy: PaymentIntentPolicyEvaluator;
  resolveTenantFlags: (ctx: ServiceCallContext, tenantId: string) => Promise<GateTenantFlags>;

  attestCounterpartyAgent: (
    ctx: ServiceCallContext,
    input: AgentAttestationInput,
  ) => Promise<AgentAttestationResult>;
  sumAgentWindowSpend: (
    ctx: ServiceCallContext,
    agentId: string,
    windowSeconds: number,
  ) => Promise<string>;

  // Core safety loaders (§6 gate checks 8 / 9.5 / 11.5)
  sumActiveReservations: (ctx: ServiceCallContext, accountId: string) => Promise<string>;
  resolveEvidence: (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ) => Promise<ResolvedEvidence[]>;
  detectDuplicates: (
    ctx: ServiceCallContext,
    input: DuplicateCheckInput,
  ) => Promise<DuplicateCheckResult>;

  resolveEscrowState?: (
    ctx: ServiceCallContext,
    input: EscrowStateInput,
  ) => Promise<ResolvedEscrowState | null>;
  resolveOnchainParams?: (
    ctx: ServiceCallContext,
    intent: {
      source_account_id: string;
      destination_counterparty_id: string;
      amount: string;
      currency: string;
    },
  ) => Promise<OnchainDispatchParams | null>;
  sourceCredentialResolver?: {
    resolve(
      ctx: ServiceCallContext,
      sourceAccountId: string,
    ): Promise<{ credentials: object; source_type: string } | null>;
  };
  metrics?: MetricsEmitter;
}

export function buildPaymentIntentService(
  deps: BuildPaymentIntentServiceDeps,
): PaymentIntentService {
  return new PaymentIntentService({
    pool: deps.pool,
    audit: deps.audit,
    // H-04: execute enqueues to the durable outbox; the rail moved to the worker.
    outbox: new OutboxService(),
    approvals: deps.approvals,
    resolveAgent: deps.resolveAgent,
    resolveTenantFlags: deps.resolveTenantFlags,
    resolveAccount: deps.resolveAccount,
    resolveCounterparty: deps.resolveCounterparty,
    evaluatePolicy: deps.evaluatePolicy,
    resolvePrincipal: deps.resolvePrincipal,
    attestCounterpartyAgent: deps.attestCounterpartyAgent,
    sumAgentWindowSpend: deps.sumAgentWindowSpend,
    sumActiveReservations: deps.sumActiveReservations,
    resolveEvidence: deps.resolveEvidence,
    detectDuplicates: deps.detectDuplicates,
    ...(deps.resolveEscrowState !== undefined
      ? { resolveEscrowState: deps.resolveEscrowState }
      : {}),
    ...(deps.resolveOnchainParams !== undefined
      ? { resolveOnchainParams: deps.resolveOnchainParams }
      : {}),
    ...(deps.sourceCredentialResolver !== undefined
      ? { sourceCredentialResolver: deps.sourceCredentialResolver }
      : {}),
    ...(deps.metrics !== undefined ? { metrics: deps.metrics } : {}),
  });
}
