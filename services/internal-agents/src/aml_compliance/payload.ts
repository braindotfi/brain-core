export type AmlScreeningStatus = "clear" | "possible_match" | "match" | "unknown";

export type AmlDocumentStatus = "cleared" | "needed" | "pending";

export type AmlRecommendedAction = "provide_docs" | "delegate" | "hold";

export interface AmlOfacScreening {
  readonly status: AmlScreeningStatus;
  readonly lists_checked: readonly string[];
  readonly timestamp: string;
}

export interface AmlPepScreening {
  readonly status: AmlScreeningStatus;
  readonly matches: readonly Record<string, unknown>[];
}

export interface AmlKycFreshness {
  readonly last_refreshed?: string;
  readonly expires?: string;
  readonly status?: "fresh" | "stale" | "unknown";
  readonly note?: string;
}

export interface AmlScreenings {
  readonly ofac: AmlOfacScreening;
  readonly pep: AmlPepScreening;
  readonly kyc_freshness: AmlKycFreshness;
}

export interface AmlRequiredDocument {
  readonly type: string;
  readonly status: AmlDocumentStatus;
  readonly description: string;
  readonly template_url?: string;
}

export interface AmlRegulatoryContext {
  readonly jurisdiction: string;
  readonly regulation_id: string;
  readonly threshold: string;
  readonly purpose_code_required: boolean;
}

export interface AmlCompliancePayload {
  readonly payment_id: string;
  readonly beneficiary_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly jurisdictions_involved: readonly string[];
  readonly screenings: AmlScreenings;
  readonly required_documents: readonly AmlRequiredDocument[];
  readonly regulatory_context: AmlRegulatoryContext;
  readonly recommended_action: AmlRecommendedAction;
  readonly deadline: string;
}
