import {
  createBrainHttpClient,
  type BrainHttpClient,
  type BrainHttpClientOptions,
} from "./client.js";
import { PolicyApprovalRequiredError, PolicyRejectedError, type PaymentIntent } from "./errors.js";
import { ActionsResource } from "./resources/actions.js";
import { AgentsResource } from "./resources/agents.js";
import { AuditResource } from "./resources/audit.js";
import { ProofResource, type Proof } from "./resources/proof.js";
import { AgentRunsResource } from "./resources/agent-runs.js";
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
import {
  CashFlowResource,
  CompoundsResource,
  type ActionTrace,
  type FinancialSnapshot,
  type SnapshotOptions,
} from "./resources/compounds.js";
import { PolicyResource } from "./resources/policy.js";
import { ProposalsResource } from "./resources/proposals.js";
import { RawResource } from "./resources/raw.js";
import { WikiResource, type AskParams } from "./resources/wiki.js";
import type { components } from "./generated/openapi.js";

export interface BrainOptions extends Omit<BrainHttpClientOptions, "baseUrl"> {
  /** Named environment shorthand. Ignored when `baseUrl` is set explicitly. */
  environment?: "production" | "sandbox" | "staging" | "local";
  /** Explicit base URL override. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Tenant ID attached to compound helpers (`brain.pay`, `brain.ask`). */
  defaultTenantId?: string;
}

export interface PayResult {
  intent: PaymentIntent;
  execution: ExecutionReceipt | undefined;
}

export const BRAIN_BASE_URLS: Record<"production" | "sandbox" | "staging" | "local", string> = {
  production: "https://api.brain.fi/v1",
  // There is no separate sandbox host: "sandbox" and "staging" are the same
  // shared testnet environment (staging-api.brain.fi), kept as two enum
  // values for naming familiarity.
  sandbox: "https://staging-api.brain.fi/v1",
  staging: "https://staging-api.brain.fi/v1",
  local: "http://localhost:3000/v1",
};

export function resolveBaseUrl(options: Pick<BrainOptions, "environment" | "baseUrl">): string {
  const url = options.baseUrl ?? BRAIN_BASE_URLS[options.environment ?? "production"];
  return url.replace(/\/$/, "");
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
  readonly baseUrl: string;
  readonly defaultTenantId: string | undefined;
  readonly accounts: AccountsResource;
  readonly transactions: TransactionsResource;
  readonly counterparties: CounterpartiesResource;
  readonly obligations: ObligationsResource;
  readonly invoices: InvoicesResource;
  readonly balances: BalancesResource;
  readonly audit: AuditResource;
  readonly proofs: ProofResource;
  readonly agentRuns: AgentRunsResource;
  readonly payments: PaymentsResource;
  readonly proposals: ProposalsResource;
  readonly actions: ActionsResource;
  readonly agents: AgentsResource;
  readonly raw: RawResource;
  readonly wiki: WikiResource;
  readonly policy: PolicyResource;
  readonly cashFlow: CashFlowResource;
  private readonly _token: string | undefined;
  private readonly _apiKey: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly compounds: CompoundsResource;

  constructor(options: BrainOptions) {
    const hasToken = typeof options.token === "string" && options.token.length > 0;
    const hasApiKey = typeof options.apiKey === "string" && options.apiKey.length > 0;
    if (hasToken === hasApiKey) {
      throw new Error(
        hasToken
          ? "Brain: pass exactly one of `token` or `apiKey`, not both"
          : "Brain: exactly one of `token` or `apiKey` is required (pass a JWT string as `token`, or a `brain_sk_...` key as `apiKey`)",
      );
    }
    const fetch = options.fetch ?? globalThis.fetch;
    if (typeof fetch !== "function") {
      throw new Error("Brain: no fetch implementation available — pass options.fetch");
    }
    this.baseUrl = resolveBaseUrl(options);
    this.defaultTenantId = options.defaultTenantId;
    this._token = options.token;
    this._apiKey = options.apiKey;
    this._fetch = fetch;
    this.http = createBrainHttpClient({ ...options, baseUrl: this.baseUrl, fetch });
    this.accounts = new AccountsResource(this.http);
    this.transactions = new TransactionsResource(this.http);
    this.counterparties = new CounterpartiesResource(this.http);
    this.obligations = new ObligationsResource(this.http);
    this.invoices = new InvoicesResource(this.http);
    this.balances = new BalancesResource(this.http);
    this.audit = new AuditResource(this.http);
    this.proofs = new ProofResource(this.http);
    this.agentRuns = new AgentRunsResource(this.http);
    this.payments = new PaymentsResource(this.http);
    this.proposals = new ProposalsResource(this.http);
    this.actions = new ActionsResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.raw = new RawResource(this.http);
    this.wiki = new WikiResource(this.http);
    this.policy = new PolicyResource(this.http);
    this.compounds = new CompoundsResource(this);
    this.cashFlow = new CashFlowResource(this);
  }

  /**
   * Convenience factory for local development. Points at `localhost:3000/v1`
   * using the provided token — useful when running `pnpm -C services/api run dev`.
   */
  static local(
    token: string,
    options?: Omit<BrainOptions, "token" | "environment" | "baseUrl">,
  ): Brain {
    return new Brain({ ...options, token, environment: "local" });
  }

  /**
   * Factory for zero-config local testing. Calls `GET /demo/token` on the
   * local Brain server to obtain a short-lived demo JWT, then constructs a
   * `Brain` instance pointed at that server. Requires a running local server
   * (`pnpm -C services/api run dev`).
   */
  static async fromDemoServer(
    baseUrl = "http://localhost:3000/v1",
    options?: Omit<BrainOptions, "token" | "baseUrl">,
  ): Promise<Brain> {
    const fetchFn = options?.fetch ?? globalThis.fetch;
    const res = await fetchFn(`${baseUrl}/demo/token`);
    if (!res.ok) {
      throw new Error(
        `Brain.fromDemoServer: demo token request failed with status ${res.status}. ` +
          `Is the local server running? (pnpm -C services/api run dev)`,
      );
    }
    const { token } = (await res.json()) as { token: string };
    return new Brain({ ...options, token, baseUrl });
  }

  getMaskedToken(): string {
    const value = this._token ?? this._apiKey ?? "";
    return value.length > 11 ? `${value.slice(0, 11)}***` : "***";
  }

  getMaskedApiKey(): string {
    return this.getMaskedToken();
  }

  getFetch(): typeof globalThis.fetch {
    return this._fetch;
  }

  /**
   * Documented as `brain.snapshot(tenantId)` on the homepage. Returns a
   * tenant's current financial picture: balances + recent transactions
   * + open obligations, fetched in parallel. Client-side aggregation;
   * no server endpoint backs it directly.
   */
  snapshot(tenantId: string, options?: SnapshotOptions): Promise<FinancialSnapshot> {
    return this.compounds.snapshot(tenantId, options);
  }

  /**
   * Documented as `brain.trace(actionId)` on the homepage. Walks the
   * audit history for a PaymentIntent (default) and returns each event
   * with its inclusion proof attached. Override `entityType` for other
   * Ledger entities. Client-side aggregation.
   */
  trace(
    entityId: string,
    options?: Parameters<CompoundsResource["trace"]>[1],
  ): Promise<ActionTrace> {
    return this.compounds.trace(entityId, options);
  }

  /**
   * Compound helper documented as `brain.ask(tenantId, question)` on the
   * homepage. Thin wrapper over `brain.wiki.question`.
   *
   * Like `brain.pay`, the `tenantId` argument is reserved for future
   * cross-tenant API keys; today the tenant is derived from the
   * authenticated principal and the argument is not sent on the wire.
   */
  ask(
    _tenantId: string,
    question: string,
    options: Omit<AskParams, "question"> = {},
  ): Promise<components["schemas"]["WikiAnswer"]> {
    return this.wiki.question({ question, ...options });
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
   * Flat helper documented as `brain.proof(action.id)` on the homepage (H-07).
   * Returns the canonical, verifiable Proof for an action (PaymentIntent or
   * agent-action id) — the §6 gate trace, evidence chain, policy decision, and
   * on-chain-anchored audit Merkle proof, plus a human-readable explanation.
   *
   * For the low-level Merkle inclusion proof of a single audit event, use
   * `brain.audit.get(eventId)` instead.
   */
  async proof(actionId: string): Promise<Proof> {
    return this.proofs.get(actionId);
  }
}
