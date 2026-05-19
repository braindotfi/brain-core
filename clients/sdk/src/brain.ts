import {
  createBrainHttpClient,
  type BrainHttpClient,
  type BrainHttpClientOptions,
} from "./client.js";
import { AuditResource, type InclusionProof } from "./resources/audit.js";
import {
  AccountsResource,
  BalancesResource,
  CounterpartiesResource,
  InvoicesResource,
  ObligationsResource,
  TransactionsResource,
} from "./resources/ledger.js";

export type BrainOptions = BrainHttpClientOptions;

/**
 * Top-level Brain SDK client. Mirrors the surface documented on
 * https://docs.brain.fi.
 *
 * Slices 1B.1 (ledger reads) and 1B.2 (audit + proof) are shipped.
 * Payment intents, agents, raw/sources, wiki, and policy follow in
 * subsequent PRs. See clients/sdk/README.md for status.
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

  constructor(options: BrainOptions) {
    this.http = createBrainHttpClient(options);
    this.accounts = new AccountsResource(this.http);
    this.transactions = new TransactionsResource(this.http);
    this.counterparties = new CounterpartiesResource(this.http);
    this.obligations = new ObligationsResource(this.http);
    this.invoices = new InvoicesResource(this.http);
    this.balances = new BalancesResource(this.http);
    this.audit = new AuditResource(this.http);
  }

  /**
   * Flat helper documented as `brain.proof(action.id)` on the homepage.
   * Returns the Merkle inclusion proof for an audit event id.
   *
   * The homepage example chains it after `brain.pay`. Until Slice 1B.3
   * lands, callers must pass the audit event id directly (e.g. from
   * `brain.audit.history("payment_intent", paymentIntentId)`).
   */
  async proof(eventId: string): Promise<InclusionProof> {
    const { inclusionProof } = await this.audit.get(eventId);
    return inclusionProof;
  }
}
