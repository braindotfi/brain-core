export type GraduationVerificationOutcome =
  | "clear"
  | "manual_review"
  | "needs_information"
  | "blocked";

export interface GraduationBusinessProfile {
  legalBusinessName: string;
  businessEmail: string;
  website: string;
  registrationCountry: string;
  companyRegistrationNumber: string | null;
  intendedUse: string;
  expectedMonthlyRequests: number | null;
}

export interface GraduationVerificationInput {
  tenantId: string;
  requestId: string;
  actorMemberId: string;
  verifiedMemberEmail: string;
  profile: GraduationBusinessProfile;
}

export interface GraduationVerificationSignal {
  checkId: string;
  outcome: GraduationVerificationOutcome;
  reasonCode: string;
  confidence: number;
}

export interface GraduationVerificationResult {
  outcome: GraduationVerificationOutcome;
  signals: GraduationVerificationSignal[];
}

export interface GraduationVerificationCheck {
  readonly id: string;
  evaluate(input: GraduationVerificationInput): Promise<GraduationVerificationSignal>;
}

export interface GraduationVerifier {
  readonly policyVersion: string;
  verify(input: GraduationVerificationInput): Promise<GraduationVerificationResult>;
}

const OUTCOME_PRIORITY: Readonly<Record<GraduationVerificationOutcome, number>> = {
  clear: 0,
  manual_review: 1,
  needs_information: 2,
  blocked: 3,
};

export class CompositeGraduationVerifier implements GraduationVerifier {
  public constructor(
    public readonly policyVersion: string,
    private readonly checks: readonly GraduationVerificationCheck[],
  ) {
    if (policyVersion.trim().length === 0) throw new Error("policyVersion is required");
    if (checks.length === 0) throw new Error("at least one verification check is required");
  }

  public async verify(input: GraduationVerificationInput): Promise<GraduationVerificationResult> {
    const signals = await Promise.all(this.checks.map((check) => check.evaluate(input)));
    const seen = new Set<string>();
    for (const signal of signals) {
      if (seen.has(signal.checkId)) throw new Error("verification check ids must be unique");
      seen.add(signal.checkId);
      if (signal.confidence < 0 || signal.confidence > 1) {
        throw new Error("verification signal confidence must be between zero and one");
      }
    }
    const outcome = signals.reduce<GraduationVerificationOutcome>(
      (current, signal) =>
        OUTCOME_PRIORITY[signal.outcome] > OUTCOME_PRIORITY[current] ? signal.outcome : current,
      "clear",
    );
    return { outcome, signals };
  }
}

/**
 * Safe Phase 1 default. It proves that the submitted address is the address
 * already verified by the authenticated member flow, and checks structural
 * domain alignment. It deliberately does not claim to perform legal KYB.
 * Until an approved jurisdiction-specific check replaces the final adapter,
 * every otherwise-clear request stops in manual review.
 */
export function buildPendingComplianceGraduationVerifier(): GraduationVerifier {
  return new CompositeGraduationVerifier("graduation_pending_compliance_v1", [
    {
      id: "verified_member_email_v1",
      async evaluate(input) {
        const matches =
          normalizeEmail(input.profile.businessEmail) === normalizeEmail(input.verifiedMemberEmail);
        return {
          checkId: this.id,
          outcome: matches ? "clear" : "needs_information",
          reasonCode: matches ? "verified_member_email_matches" : "business_email_not_verified",
          confidence: 1,
        };
      },
    },
    {
      id: "business_domain_alignment_v1",
      async evaluate(input) {
        const emailDomain = normalizeEmail(input.profile.businessEmail).split("@")[1] ?? "";
        const websiteDomain = normalizeHostname(new URL(input.profile.website).hostname);
        const matches = emailDomain === websiteDomain;
        return {
          checkId: this.id,
          outcome: matches ? "clear" : "manual_review",
          reasonCode: matches ? "business_domain_aligned" : "business_domain_mismatch",
          confidence: 1,
        };
      },
    },
    {
      id: "approved_compliance_policy_v1",
      async evaluate() {
        return {
          checkId: this.id,
          outcome: "manual_review",
          reasonCode: "compliance_policy_not_configured",
          confidence: 1,
        };
      },
    },
  ]);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}
