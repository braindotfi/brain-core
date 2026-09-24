export interface AmlJurisdictionRule {
  readonly jurisdiction: string;
  readonly regulation_id: string;
  readonly threshold: string;
  readonly currency: string;
  readonly purpose_code_required: boolean;
  readonly required_documents: readonly {
    readonly type: string;
    readonly description: string;
    readonly template_url?: string;
  }[];
}

export const AML_JURISDICTION_RULES: readonly AmlJurisdictionRule[] = [
  {
    jurisdiction: "AE",
    regulation_id: "UAE-CBUAE-AML-THRESHOLD-55000",
    threshold: "55000.00",
    currency: "AED",
    purpose_code_required: true,
    required_documents: [
      {
        type: "beneficiary_kyc",
        description: "Current beneficiary KYC profile",
      },
      {
        type: "purpose_of_payment",
        description: "Payment purpose and supporting invoice or contract",
      },
    ],
  },
  {
    jurisdiction: "US",
    regulation_id: "US-BSA-CTR-10000",
    threshold: "10000.00",
    currency: "USD",
    purpose_code_required: false,
    required_documents: [
      {
        type: "beneficiary_kyc",
        description: "Current beneficiary KYC profile",
      },
      {
        type: "source_of_funds",
        description: "Source of funds evidence for payment review",
      },
    ],
  },
];

export const DEFAULT_AML_JURISDICTION_RULE: AmlJurisdictionRule = {
  jurisdiction: "GLOBAL",
  regulation_id: "GLOBAL-AML-REVIEW",
  threshold: "0.00",
  currency: "USD",
  purpose_code_required: false,
  required_documents: [
    {
      type: "beneficiary_kyc",
      description: "Current beneficiary KYC profile",
    },
  ],
};
