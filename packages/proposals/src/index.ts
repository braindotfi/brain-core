export type ProposalDomainDecisionId =
  | "confirm_legit"
  | "block_merchant"
  | "freeze_card"
  | "gather_evidence"
  | "contest"
  | "accept"
  | "fight"
  | "refund"
  | "confirm_all_matches"
  | "escalate_to_accountant"
  | "approve_as_new"
  | "reject_duplicate"
  | "hold_and_verify"
  | "provide_docs"
  | "delegate"
  | "hold"
  | "downgrade"
  | "renegotiate"
  | "cancel"
  | "renew";

export interface ProposalDomainDecision {
  readonly id: ProposalDomainDecisionId;
  readonly label: string;
  readonly meaning: string;
}

export interface ProposalDecisionContext {
  readonly decide_by: string;
  readonly if_wrong: string;
  readonly reversible: {
    readonly state: "yes" | "no" | "na";
    readonly label: string;
  };
}

export interface FraudAnomalySignals {
  readonly geo_mismatch?: {
    readonly normal_regions: readonly string[];
    readonly observed_region: string;
  };
  readonly off_hours?: {
    readonly typical_window: string;
    readonly observed_hour: string;
  };
  readonly normal_vs_current?: {
    readonly avg_amount?: unknown;
    readonly typical_hours?: unknown;
    readonly typical_merchant_type?: unknown;
    readonly geo?: unknown;
  };
}

export interface VendorRiskComparison {
  readonly bank_on_file?: BankComparisonEntry;
  readonly bank_on_invoice?: BankComparisonEntry;
  readonly quantity_a?: unknown;
  readonly quantity_b?: unknown;
  readonly po_ref_a?: string;
  readonly po_ref_b?: string;
}

export interface CollectionsDraftEmail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly body: readonly string[];
  readonly edit_actions: readonly string[];
}

export interface PayableCashImpact {
  readonly source_account_id: string;
  readonly balance_before: number;
  readonly balance_after: number;
}

export interface BankComparisonEntry {
  readonly bank_name?: string;
  readonly routing_masked?: string;
  readonly account_masked?: string;
  readonly beneficiary?: string;
}

export interface DisputeHistoricalWinRate {
  readonly pct: number;
  readonly sample_size: number;
  readonly time_window: string;
}

export interface TreasuryAllocation {
  readonly operating: unknown;
  readonly reserve: unknown;
  readonly other_accounts: unknown;
}

export interface TreasurySafetyMeter {
  readonly current: unknown;
  readonly floor: unknown;
  readonly ceiling: unknown;
  readonly unit: string;
}

export interface MoneyAmount {
  readonly amount: string;
  readonly currency: string;
}

export interface ReconciliationCloseAggregate {
  readonly period_start: string;
  readonly period_end: string;
  readonly matched_count: number;
  readonly unmatched_count: number;
  readonly matched_total: unknown;
  readonly unmatched_total: unknown;
  readonly drift: unknown;
}

export interface ReconciliationAccountant {
  readonly name: string;
  readonly org: string;
  readonly email: string;
}

export interface ReconciliationMateriality {
  readonly unmatched_amount: number;
  readonly monthly_revenue: number;
  readonly pct: number;
}

export interface CashForecastDriver {
  readonly name: string;
  readonly category: string;
  readonly monthly_impact: unknown;
  readonly direction: string;
}

export interface CashForecastRunwayPoint {
  readonly date: string;
  readonly projected_balance: unknown;
  readonly projected_runway_months: unknown;
}

export interface RevenueConcentration {
  readonly top_customer_pct: number;
  readonly top_customer_amount: unknown;
  readonly breakdown: readonly RevenueConcentrationBreakdown[];
}

export interface RevenueConcentrationBreakdown {
  readonly name: string;
  readonly amount: unknown;
  readonly pct: number;
}

export interface HistoricalConcentrationPoint {
  readonly period: string;
  readonly top_customer_pct: number;
}

export interface PipelineCoverage {
  readonly quarter: string;
  readonly plan: unknown;
  readonly weighted_pipeline: unknown;
  readonly coverage_pct: number;
}

export interface SubscriptionAlternative {
  readonly name: string;
  readonly note: string;
  readonly price: string;
}

export interface FlaggedInvoice {
  readonly id: string;
  readonly amount: unknown;
  readonly currency: string;
  readonly invoice_date: string;
  readonly line_items_hash: string;
  readonly vendor: unknown;
}

export interface SuspectedOriginalInvoice {
  readonly id: string;
  readonly amount: unknown;
  readonly currency: string;
  readonly invoice_date: string;
  readonly line_items_hash: string;
  readonly payment_status: string;
}

export interface InvoiceIntegrityMatchConfidence {
  readonly pct: number;
  readonly signals: readonly string[];
}

export type InvoiceIntegrityFindingKind =
  | "duplicate"
  | "structuring"
  | "threshold_avoidance"
  | "high_value_new_vendor";

export interface ProposalRailFields {
  readonly decision_context?: ProposalDecisionContext;
  readonly signals?: FraudAnomalySignals;
  readonly comparison?: VendorRiskComparison;
  readonly draft_email?: CollectionsDraftEmail;
  readonly cash_impact?: PayableCashImpact;
  readonly historical_win_rate?: DisputeHistoricalWinRate;
  readonly allocation_before?: TreasuryAllocation;
  readonly allocation_after?: TreasuryAllocation;
  readonly safety_meter?: TreasurySafetyMeter;
  readonly estimated_annual_yield_gain?: MoneyAmount;
  readonly close_aggregate?: ReconciliationCloseAggregate;
  readonly accountant?: ReconciliationAccountant;
  readonly materiality?: ReconciliationMateriality;
  readonly horizon_days?: number;
  readonly drivers?: readonly CashForecastDriver[];
  readonly runway_projection?: readonly CashForecastRunwayPoint[];
  readonly concentration?: RevenueConcentration;
  readonly historical_concentration?: readonly HistoricalConcentrationPoint[];
  readonly pipeline_coverage?: PipelineCoverage;
  readonly alternatives?: readonly SubscriptionAlternative[];
  readonly flagged_invoice?: FlaggedInvoice;
  readonly suspected_original?: SuspectedOriginalInvoice;
  readonly match_confidence?: InvoiceIntegrityMatchConfidence;
  readonly finding_kind?: InvoiceIntegrityFindingKind;
  readonly screenings?: unknown;
  readonly required_documents?: readonly unknown[];
  readonly regulatory_context?: unknown;
  readonly jurisdictions_involved?: readonly string[];
  readonly deadline?: string;
  readonly seats?: unknown;
  readonly underutilization?: unknown;
  readonly options?: readonly unknown[];
  readonly decisions?: readonly ProposalDomainDecision[];
}

export interface TenantProfile {
  readonly tenant_id: string;
  readonly legal_name?: string | null;
  readonly dba_name?: string | null;
  readonly address_line1?: string | null;
  readonly address_line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postal_code?: string | null;
  readonly country?: string | null;
  readonly tax_id?: string | null;
  readonly industry?: string | null;
  readonly jurisdiction?: string | null;
  readonly fiscal_year_end?: string | null;
  readonly accountant?: TenantAccountant | null;
  readonly updated_at?: string | null;
}

export interface TenantAccountant {
  readonly name: string;
  readonly org: string;
  readonly email: string;
}

export type TenantProfilePatch = Partial<
  Omit<TenantProfile, "tenant_id" | "updated_at"> & { readonly ein: string }
>;

export interface NotificationPreferences {
  readonly tenant_id: string;
  readonly proactive_briefs_enabled: boolean;
  readonly proactive_alerts_enabled: boolean;
  readonly proactive_alert_channels: readonly ("email" | "push" | "slack")[];
  readonly quiet_hours?: Record<string, unknown> | null;
  readonly agent_mute_list: readonly string[];
  readonly updated_at?: string;
}

export type NotificationPreferencesPatch = Partial<
  Pick<
    NotificationPreferences,
    | "proactive_briefs_enabled"
    | "proactive_alerts_enabled"
    | "proactive_alert_channels"
    | "quiet_hours"
    | "agent_mute_list"
  >
>;

export type TenantIntegrationAdapterKind =
  | "ofac"
  | "pep"
  | "kyc"
  | "card_issuer"
  | "dispute"
  | "reversal"
  | "directory"
  | "saas_vendor"
  | "llm"
  | "notification"
  | "blob";

export interface TenantIntegration {
  readonly tenant_id: string;
  readonly adapter_kind: TenantIntegrationAdapterKind;
  readonly provider: string;
  readonly enabled: boolean;
  readonly requires_setup: boolean;
  readonly missing_env: readonly string[];
  readonly config_keys: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TenantIntegrationInput {
  readonly provider: string;
  readonly enabled?: boolean;
  readonly config?: Record<string, unknown>;
}

export interface TwoFactorMethod {
  readonly method: "authenticator" | "sms" | "backup_codes";
  readonly status: "pending" | "enabled";
  readonly phone_number?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface TwoFactorEnrollment extends TwoFactorMethod {
  readonly enrollment_id: string;
  readonly qr_uri?: string;
  readonly backup_codes?: readonly string[];
}

export interface TwoFactorMethodsResponse {
  readonly enabled: boolean;
  readonly methods: readonly TwoFactorMethod["method"][];
  readonly method_details?: readonly TwoFactorMethod[];
}

export interface TrustedDevice {
  readonly id: string;
  readonly label: string;
  readonly last_used_at?: string | null;
  readonly ip?: string | null;
  readonly user_agent?: string | null;
  readonly created_at: string;
  readonly updated_at?: string;
}

export interface ExchangeQuoteRequest {
  readonly source_currency: string;
  readonly destination_currency: string;
  readonly amount: string;
}

export interface ExchangeQuote {
  readonly quote_id: string;
  readonly rate_lock_reference: string;
  readonly source_currency: string;
  readonly destination_currency: string;
  readonly amount: string;
  readonly rate: string;
  readonly fee_cents: number;
  readonly expires_at: string;
}

export interface AgentOverviewItem {
  readonly agent_key: string;
  readonly display_name: string;
  readonly description: string;
  readonly authority_summary: {
    readonly default: "auto" | "propose" | "notify_only";
    readonly auto_conditions: readonly Record<string, unknown>[];
    readonly per_user_overrides_count: number;
  };
  readonly weekly_decision_count: number;
  readonly weekly_auto_count: number;
  readonly weekly_needed_you_count: number;
  readonly active_rules_count: number;
  readonly last_activity_at?: string | null;
}

export interface UiAccount {
  readonly id: string;
  readonly type: "checking" | "savings" | "card" | "wallet";
  readonly name: string;
  readonly institution?: string | null;
  readonly balance?: string | number | null;
  readonly currency: string;
  readonly last_sync?: string | null;
}

export interface UiTransaction {
  readonly id: string;
  readonly amount: string | number;
  readonly currency: string;
  readonly direction: "inflow" | "outflow" | "transfer" | "adjustment";
  readonly transaction_date: string | null;
  readonly posted_date?: string | null;
  readonly counterparty_id?: string | null;
  readonly status: string;
  readonly description_raw?: string | null;
  readonly description_normalized?: string | null;
}

export interface UiAccountDetail {
  readonly account: UiAccount;
  readonly transactions: readonly UiTransaction[];
  readonly next_cursor: string | null;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly risk_level?: string | null;
  readonly verified_status?: string | null;
  readonly aliases?: readonly string[];
  readonly linked_accounts?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly status?: "active" | "archived";
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface ContactInput {
  readonly name: string;
  readonly type?: string;
  readonly risk_level?: string;
  readonly verified_status?: string;
  readonly aliases?: readonly string[];
  readonly linked_accounts?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export type ContactPatch = Partial<ContactInput>;

export interface DepositInstructions {
  readonly account_id: string;
  readonly method: "wire" | "ach" | "onchain";
  readonly bank_name?: string | null;
  readonly routing_number?: string | null;
  readonly account_number?: string | null;
  readonly memo_reference?: string | null;
  readonly onchain_address?: string | null;
  readonly created_at?: string;
}

export interface GlobalSearchRequest {
  readonly query: string;
  readonly q?: string;
  readonly kinds?: readonly ("proposal" | "thread" | "account" | "counterparty" | "audit_entry")[];
  readonly limit?: number;
}

export interface GlobalSearchResult {
  readonly kind: "proposal" | "thread" | "account" | "counterparty" | "audit_entry";
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly meta?: Record<string, unknown>;
  readonly ref_url?: string;
  readonly score: number;
}

export type GlobalSearchResponse = readonly GlobalSearchResult[];
