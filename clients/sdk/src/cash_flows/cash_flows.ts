/**
 * `brain.cashFlow.*` — cash-flow aggregation read.
 *
 * Wraps the /v1/ledger/cash_flows route added in PLAN-FIRST #12. Source:
 * https://docs.brain.fi/api-reference/ledger-api ("cash flows") and
 * https://docs.brain.fi/build/read-a-financial-picture.
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type CashFlowSummary = Schemas["CashFlowSummary"];

export interface CashFlowSummarizeOptions {
  readonly tenantId: string;
  /** Window in days, ending now. Default 30, max 365. */
  readonly days?: number;
  /** Restrict to a single currency. When omitted, response groups by currency. */
  readonly currency?: string;
}

export class CashFlowModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Summarize cash flow over a recent window.
   *
   * Implements `GET /ledger/cash_flows` (operationId `summarizeCashFlow`).
   * @see https://docs.brain.fi/build/read-a-financial-picture
   */
  public async summarize(opts: CashFlowSummarizeOptions): Promise<CashFlowSummary> {
    return this.http.get<CashFlowSummary>("/ledger/cash_flows", {
      query: {
        tenantId: opts.tenantId,
        days: opts.days,
        currency: opts.currency,
      },
    });
  }
}
