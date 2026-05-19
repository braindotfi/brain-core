import {
  createBrainHttpClient,
  type BrainHttpClient,
  type BrainHttpClientOptions,
} from "./client.js";
import { PolicyApprovalRequiredError, PolicyRejectedError, type PaymentIntent } from "./errors.js";
import { ActionsResource } from "./resources/actions.js";
import { AuditResource, type InclusionProof } from "./resources/audit.js";
import {
  AccountsResource,
  BalancesResource,
  CounterpartiesResource,
  InvoicesResource,
  ObligationsResource,
  TransactionsResource,
} from "./resources/ledger.js";
import {
  PaymentsResource,
  type CreatePaymentIntentParams,
  type ExecutionReceipt,
  type RejectPaymentIntentParams,
} from "./resources/payments.js";

export type BrainOptions = BrainHttpClientOptions;

export interface PayResult {
  intent: PaymentIntent;
  execution: ExecutionReceipt | undefined;
}

/**
 * Top-level Brain SDK client. Mirrors the surface documented on
 * https://docs.brain.fi.
 *
 * Slices 1B.1 (ledger), 1B.2 (audit), 1B.3 (payment intents + actions)
 * are shipped. Agents, raw/sources, wiki, policy, and client-side
 * compounds follow in subsequent PRs. See clients/sdk/README.md for
 * status.
 */
export class Brain {
  readonly http: BrainHttpClient;
  readonly accounts: AccountsResource;
  readonly transactions: TransactionsResource;
  readonly counterparties: CounterpartiesResource;
  readonly obligations: ObligationsResource;
  readonly invoices: InvoicesResource;
  readonly balances: BalancesResource;
  readonly audit: AuditResource;
  readonly payments: PaymentsResource;
  readonly actions: ActionsResource;

  constructor(options: BrainOptions) {
    this.http = createBrainHttpClient(options);
    this.accounts = new AccountsResource(this.http);
    this.transactions = new TransactionsResource(this.http);
    this.counterparties = new CounterpartiesResource(this.http);
    this.obligations = new ObligationsResource(this.http);
    this.invoices = new InvoicesResource(this.http);
    this.balances = new BalancesResource(this.http);
    this.audit = new AuditResource(this.http);
    this.payments = new PaymentsResource(this.http);
    this.actions = new ActionsResource(this.http);
  }

  /**
   * Compound helper documented as `brain.pay(tenantId, { ... })` on the
   * homepage. Creates a PaymentIntent and reads the resulting `status`
   * to decide what to do next:
   *
   * - status=`approved` → executes; returns `{ intent, execution }`.
   * - status=`pending_approval` → throws `PolicyApprovalRequiredError`
   *   carrying the intent. Caller routes it to an approver, then resumes
   *   via `brain.payments.approve(intent.id)` followed by
   *   `brain.payments.execute(intent.id)`.
   * - status=`rejected` → throws `PolicyRejectedError` carrying the
   *   intent. Inspect `intent.policy_decision_id` for the rule trace.
   * - any other status (proposed, executed, failed, cancelled) → returns
   *   `{ intent, execution: undefined }`. Caller decides whether to
   *   poll, retry, or escalate.
   *
   * The `tenantId` argument is reserved for future cross-tenant API keys;
   * today the tenant is derived from the authenticated principal and the
   * argument is not sent on the wire. Pass any non-empty string.
   */
  async pay(_tenantId: string, params: CreatePaymentIntentParams): Promise<PayResult> {
    const intent = await this.payments.create(params);

    if (intent.status === "rejected") {
      throw new PolicyRejectedError(intent);
    }
    if (intent.status === "pending_approval") {
      throw new PolicyApprovalRequiredError(intent);
    }
    if (intent.status === "approved" && intent.id) {
      const execution = await this.payments.execute(intent.id);
      return { intent, execution };
    }

    return { intent, execution: undefined };
  }

  /**
   * Flat helper. Documented as `brain.approve(action.id)`. Approves a
   * PaymentIntent that the policy gate held in `confirm` state. Returns
   * the updated PaymentIntent. To then execute, call
   * `brain.payments.execute(id)`.
   */
  approve(id: string): Promise<PaymentIntent> {
    return this.payments.approve(id);
  }

  /**
   * Flat helper. Documented as `brain.reject(action.id, { reason })`.
   * Rejects a PaymentIntent. Returns the updated PaymentIntent.
   */
  reject(id: string, params?: RejectPaymentIntentParams): Promise<PaymentIntent> {
    return this.payments.reject(id, params);
  }

  /**
   * Flat helper documented as `brain.proof(action.id)` on the homepage.
   * Returns the Merkle inclusion proof for an audit event id.
   *
   * The homepage example chains it after `brain.pay`. Until the
   * PaymentIntent shape carries an `audit_event_id` field, callers
   * resolve the event id via `brain.audit.history("payment_intent", id)`
   * first.
   */
  async proof(eventId: string): Promise<InclusionProof> {
    const { inclusionProof } = await this.audit.get(eventId);
    return inclusionProof;
  }
}
