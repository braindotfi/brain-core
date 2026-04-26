/**
 * Phase-5 stub matchers.
 *
 * Each documents the intended criteria so a future PR can drop in the
 * concrete implementation without rediscovery. Stubs return zero matches
 * and produce no audit events — they're safe to register in the registry
 * and run on schedule.
 */

import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

abstract class StubMatcher implements Matcher {
  public abstract readonly matchType: Matcher["matchType"];
  protected abstract readonly criteriaNote: string;

  public async run(_deps: MatcherContext, _input: MatcherInput): Promise<MatcherResult> {
    return {
      matchType: this.matchType,
      matchesProduced: [],
      candidatesScanned: 0,
      notes: `stub matcher; ${this.criteriaNote}`,
    };
  }
}

/** ledger_documents(bank_statement) ↔ ledger_balances on (account_id, as_of). */
export class StatementBalanceMatcher extends StubMatcher {
  public readonly matchType = "statement_balance" as const;
  protected readonly criteriaNote =
    "compare extracted_fields.balance vs latest ledger_balance for the same account+date.";
}

/** on-chain ledger_transactions ↔ exchange-deposit ledger_transactions. */
export class WalletTransferMatcher extends StubMatcher {
  public readonly matchType = "wallet_transfer" as const;
  protected readonly criteriaNote =
    "pair an outflow chain_evm tx (status=posted) with an inflow on a wallet/exchange account by amount + ±10 minute timestamp window.";
}

/** Payroll obligation ↔ outflow tx near pay date. */
export class PayrollBankDebitMatcher extends StubMatcher {
  public readonly matchType = "payroll_bank_debit" as const;
  protected readonly criteriaNote =
    "match obligations of type=payroll to outflow transactions at the obligation.amount_due ±0.5%, posted ±3 days from due_date.";
}

/** Subscription obligation ↔ recurring tx. */
export class SubscriptionChargeMatcher extends StubMatcher {
  public readonly matchType = "subscription_charge" as const;
  protected readonly criteriaNote =
    "match obligations of type=subscription to outflow transactions at amount_due (exact) recurring on the same monthly cadence.";
}

/** Card statement obligation ↔ tx. */
export class CardChargeMatcher extends StubMatcher {
  public readonly matchType = "card_charge" as const;
  protected readonly criteriaNote =
    "match obligations of type=card_statement to the tx posted as the statement-payment outflow on the linked checking account.";
}
