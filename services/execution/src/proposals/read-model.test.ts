import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TYPES,
  decisionsForProposal,
  projectProposalRailFields,
  resolvePublicProposalType,
  type ProposalType,
} from "./read-model.js";

describe("proposal read model type resolver", () => {
  it("maps every public proposal type directly", () => {
    for (const type of PROPOSAL_TYPES) {
      expect(resolvePublicProposalType({ actionType: type })).toBe(type);
    }
  });

  it("maps stored action types that are not public types", () => {
    const cases: Array<{ actionType: string; expected: ProposalType }> = [
      { actionType: "flag_transaction", expected: "fraud_anomaly" },
      { actionType: "block_payment", expected: "vendor_risk" },
      { actionType: "propose_match", expected: "reconciliation" },
      { actionType: "recommend_card", expected: "travel_finance" },
      { actionType: "recommend_savings_transfer", expected: "savings" },
      { actionType: "tag_tax_item", expected: "tax_prep" },
      { actionType: "remind", expected: "bill_management" },
      { actionType: "flag_duplicate_invoice", expected: "invoice_integrity" },
      { actionType: "aml_compliance", expected: "aml_compliance" },
      { actionType: "subscription_management", expected: "subscription_management" },
    ];

    for (const row of cases) {
      expect(resolvePublicProposalType({ actionType: row.actionType })).toBe(row.expected);
    }
  });

  it("uses agent role to resolve ambiguous action names", () => {
    expect(resolvePublicProposalType({ actionType: "notify", joinedAgentRole: "compliance" })).toBe(
      "compliance",
    );
    expect(
      resolvePublicProposalType({ actionType: "notify", joinedAgentRole: "personal_budget" }),
    ).toBe("personal_budget");
    expect(
      resolvePublicProposalType({ actionType: "create_task", joinedAgentRole: "collections" }),
    ).toBe("collections");
    expect(resolvePublicProposalType({ actionType: "escalate", joinedAgentRole: "dispute" })).toBe(
      "dispute",
    );
  });

  it("keeps money-moving payment intent rows domain-specific when agent role is known", () => {
    expect(
      resolvePublicProposalType({
        actionType: "ach_outbound",
        joinedAgentRole: "bill_management",
      }),
    ).toBe("bill_management");
    expect(
      resolvePublicProposalType({
        actionType: "onchain_transfer",
        joinedAgentRole: "treasury",
      }),
    ).toBe("treasury");
    expect(resolvePublicProposalType({ actionType: "ach_outbound" })).toBeNull();
  });
});

describe("proposal read model decisions", () => {
  it("does not expose a decision for a superseded proposal", () => {
    expect(decisionsForProposal("collections", "propose", "superseded")).toEqual([]);
  });
});

describe("proposal rail payload contracts", () => {
  const decisionContext = {
    decide_by: "Fri Sep 25, 4 days",
    if_wrong: "Approving too early can create loss. Waiting too long can delay valid work.",
    reversible: { state: "yes" as const, label: "Yes before execution" },
  };

  it("projects non-empty decision context for every inbox rail", () => {
    const rails: ProposalType[] = [
      "vendor_risk",
      "dispute",
      "aml_compliance",
      "payment",
      "collections",
      "treasury",
      "cash_forecast",
      "revenue_intel",
      "fraud_anomaly",
      "subscription_management",
      "reconciliation",
      "invoice_integrity",
    ];

    for (const rail of rails) {
      const fields = projectProposalRailFields(rail, { decision_context: decisionContext });
      expect(fields.decision_context).toEqual(decisionContext);
      expect(fields.decision_context?.decide_by).not.toEqual("");
      expect(fields.decision_context?.if_wrong).not.toEqual("");
      expect(fields.decision_context?.reversible.label).not.toEqual("");
    }
  });

  it("projects fraud anomaly rail fields and domain decisions", () => {
    const fields = projectProposalRailFields("fraud_anomaly", {
      signals: {
        geo_mismatch: { normal_regions: ["AE"], observed_region: "US" },
        off_hours: { typical_window: "09:00-18:00", observed_hour: "02:00" },
        normal_vs_current: {
          avg_amount: "120.00",
          typical_hours: "09:00-18:00",
          typical_merchant_type: "software",
          geo: "AE",
        },
      },
    });

    expect(fields.signals).toMatchObject({
      geo_mismatch: { observed_region: "US" },
      off_hours: { observed_hour: "02:00" },
      normal_vs_current: { typical_merchant_type: "software" },
    });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "confirm_legit",
      "block_merchant",
      "freeze_card",
    ]);
  });

  it("projects collections draft email fields", () => {
    const fields = projectProposalRailFields("collections", {
      decision_context: decisionContext,
      draft_email: {
        to: "ap@example.com",
        from: "ar@example.com",
        subject: "Invoice INV-1 payment follow-up",
        body: ["Hello Example,", "Invoice INV-1 is overdue."],
        edit_actions: ["Edit draft", "Soften tone"],
      },
    });

    expect(fields.draft_email).toMatchObject({
      to: "ap@example.com",
      subject: "Invoice INV-1 payment follow-up",
    });
  });

  it("projects payable cash impact fields", () => {
    const fields = projectProposalRailFields("payment", {
      decision_context: decisionContext,
      cash_impact: {
        source_account_id: "acct_1",
        balance_before: 1000,
        balance_after: 500,
      },
    });

    expect(fields.cash_impact).toEqual({
      source_account_id: "acct_1",
      balance_before: 1000,
      balance_after: 500,
    });
  });

  it("projects vendor risk comparison fields", () => {
    const comparison = {
      bank_on_file: {
        bank_name: "Acme Bank",
        routing_masked: "****1234",
        account_masked: "****9988",
        beneficiary: "Northstar LLC",
      },
      bank_on_invoice: {
        bank_name: "New Bank",
        routing_masked: "****5678",
        account_masked: "1111222233331122",
        beneficiary: "Northstar LLC",
      },
    };

    expect(projectProposalRailFields("vendor_risk", { comparison }).comparison).toEqual({
      ...comparison,
      bank_on_invoice: {
        ...comparison.bank_on_invoice,
        account_masked: "****1122",
      },
    });
  });

  it("projects dispute win rate fields and domain decisions", () => {
    const fields = projectProposalRailFields("dispute", {
      historical_win_rate: { pct: 72, sample_size: 50, time_window: "12m" },
    });

    expect(fields.historical_win_rate).toEqual({ pct: 72, sample_size: 50, time_window: "12m" });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "gather_evidence",
      "contest",
      "accept",
      "fight",
      "refund",
    ]);
  });

  it("projects treasury allocation fields", () => {
    const fields = projectProposalRailFields("treasury", {
      allocation_before: { operating: "100.00", reserve: "50.00", other_accounts: "25.00" },
      allocation_after: { operating: "80.00", reserve: "70.00", other_accounts: "25.00" },
      safety_meter: { current: "100.00", floor: "75.00", ceiling: "150.00", unit: "USD" },
      estimated_annual_yield_gain: { amount: "1200.00", currency: "USD" },
    });

    expect(fields.allocation_before).toMatchObject({ operating: "100.00" });
    expect(fields.allocation_after).toMatchObject({ reserve: "70.00" });
    expect(fields.safety_meter).toMatchObject({ unit: "USD" });
    expect(fields.estimated_annual_yield_gain).toEqual({ amount: "1200.00", currency: "USD" });
  });

  it("projects reconciliation close aggregate fields and domain decisions", () => {
    const fields = projectProposalRailFields("reconciliation", {
      close_aggregate: {
        period_start: "2026-08-01",
        period_end: "2026-08-31",
        matched_count: 10,
        unmatched_count: 2,
        matched_total: "1000.00",
        unmatched_total: "50.00",
        drift: "0.02",
      },
      accountant: { name: "Sam Lee", org: "Ledger CPA", email: "sam@example.com" },
      materiality: { unmatched_amount: 50, monthly_revenue: 10000, pct: 0.5 },
    });

    expect(fields.close_aggregate).toMatchObject({ unmatched_count: 2 });
    expect(fields.accountant).toMatchObject({ org: "Ledger CPA" });
    expect(fields.materiality).toMatchObject({ pct: 0.5 });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "confirm_all_matches",
      "escalate_to_accountant",
    ]);
  });

  it("projects cash forecast horizon, driver, and runway fields", () => {
    const fields = projectProposalRailFields("cash_forecast", {
      horizon_days: 180,
      drivers: [
        {
          name: "Payroll",
          category: "expense",
          monthly_impact: "50000.00",
          direction: "outflow",
        },
      ],
      runway_projection: [
        { date: "2026-09-30", projected_balance: "250000.00", projected_runway_months: 5 },
      ],
    });

    expect(fields.horizon_days).toBe(180);
    expect(fields.drivers?.[0]).toMatchObject({ name: "Payroll" });
    expect(fields.runway_projection?.[0]).toMatchObject({ projected_runway_months: 5 });
  });

  it("projects revenue intelligence concentration fields", () => {
    const fields = projectProposalRailFields("revenue_intel", {
      concentration: {
        top_customer_pct: 42,
        top_customer_amount: "420000.00",
        breakdown: [{ name: "Brightline", amount: "420000.00", pct: 42 }],
      },
      historical_concentration: [{ period: "2026-Q2", top_customer_pct: 38 }],
      pipeline_coverage: {
        quarter: "2026-Q3",
        plan: "1000000.00",
        weighted_pipeline: "1250000.00",
        coverage_pct: 125,
      },
    });

    expect(fields.concentration).toMatchObject({ top_customer_pct: 42 });
    expect(fields.historical_concentration?.[0]).toEqual({
      period: "2026-Q2",
      top_customer_pct: 38,
    });
    expect(fields.pipeline_coverage).toMatchObject({ coverage_pct: 125 });
  });

  it("projects invoice integrity fields and domain decisions", () => {
    const fields = projectProposalRailFields("invoice_integrity", {
      flagged_invoice: {
        id: "inv_1",
        amount: "100.00",
        currency: "USD",
        invoice_date: "2026-08-01",
        line_items_hash: "hash_a",
        vendor: "Acme",
      },
      suspected_original: {
        id: "inv_0",
        amount: "100.00",
        currency: "USD",
        invoice_date: "2026-07-31",
        line_items_hash: "hash_a",
        payment_status: "paid",
      },
      match_confidence: { pct: 97, signals: ["amount", "vendor", "line_items"] },
      finding_kind: "duplicate",
      comparison: {
        quantity_a: 4,
        quantity_b: 4,
        po_ref_a: "PO-1",
        po_ref_b: "PO-1",
      },
    });

    expect(fields.flagged_invoice).toMatchObject({ id: "inv_1" });
    expect(fields.suspected_original).toMatchObject({ payment_status: "paid" });
    expect(fields.match_confidence).toEqual({
      pct: 97,
      signals: ["amount", "vendor", "line_items"],
    });
    expect(fields.finding_kind).toBe("duplicate");
    expect(fields.comparison).toMatchObject({ po_ref_a: "PO-1", quantity_a: 4 });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "approve_as_new",
      "reject_duplicate",
      "hold_and_verify",
    ]);
  });

  it("projects AML compliance fields and domain decisions", () => {
    const fields = projectProposalRailFields("aml_compliance", {
      jurisdictions_involved: ["AE", "US"],
      screenings: { ofac: { status: "clear" }, pep: { status: "clear" } },
      required_documents: [{ type: "beneficiary_kyc", status: "needed" }],
      regulatory_context: { jurisdiction: "US", threshold: "10000.00" },
      deadline: "2026-09-21T00:00:00.000Z",
    });

    expect(fields.jurisdictions_involved).toEqual(["AE", "US"]);
    expect(fields.required_documents?.[0]).toMatchObject({ type: "beneficiary_kyc" });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "provide_docs",
      "delegate",
      "hold",
    ]);
  });

  it("projects subscription management fields and domain decisions", () => {
    const fields = projectProposalRailFields("subscription_management", {
      seats: { licensed: 10, active_30d: 4, active_users: [] },
      underutilization: { percent: 60, dollar_value: "720.00" },
      options: [{ label: "downgrade", recommended: true }],
      alternatives: [
        { name: "Pipedrive", note: "Sales pipeline focused", price: "From 14 per seat monthly" },
      ],
    });

    expect(fields.seats).toMatchObject({ licensed: 10 });
    expect(fields.options?.[0]).toMatchObject({ label: "downgrade" });
    expect(fields.alternatives?.[0]).toMatchObject({ name: "Pipedrive" });
    expect(fields.decisions?.map((decision) => decision.id)).toEqual([
      "downgrade",
      "renegotiate",
      "cancel",
      "renew",
    ]);
  });
});
