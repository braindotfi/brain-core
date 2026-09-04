import { describe, expect, it } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import {
  CompositeGraduationVerifier,
  buildPendingComplianceGraduationVerifier,
  type GraduationVerificationCheck,
  type GraduationVerificationInput,
} from "./verifier.js";

const input: GraduationVerificationInput = {
  tenantId: newTenantId(),
  requestId: "grad_01K123456789ABCDEFGHJKMNPQ",
  actorMemberId: newUserId(),
  verifiedMemberEmail: "owner@brightline.example",
  profile: {
    legalBusinessName: "Brightline Labs",
    businessEmail: "owner@brightline.example",
    website: "https://www.brightline.example/",
    registrationCountry: "US",
    companyRegistrationNumber: null,
    intendedUse: "Financial operations",
    expectedMonthlyRequests: 1000,
  },
};

describe("graduation verifier", () => {
  it("fails closed to manual review while the compliance policy is unconfigured", async () => {
    const result = await buildPendingComplianceGraduationVerifier().verify(input);
    expect(result.outcome).toBe("manual_review");
    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "verified_member_email_v1",
          outcome: "clear",
        }),
        expect.objectContaining({
          checkId: "business_domain_alignment_v1",
          outcome: "clear",
        }),
        expect.objectContaining({
          checkId: "approved_compliance_policy_v1",
          reasonCode: "compliance_policy_not_configured",
        }),
      ]),
    );
  });

  it("requires new evidence when the business email is not the verified member email", async () => {
    const result = await buildPendingComplianceGraduationVerifier().verify({
      ...input,
      profile: { ...input.profile, businessEmail: "other@brightline.example" },
    });
    expect(result.outcome).toBe("needs_information");
    expect(result.signals).toContainEqual(
      expect.objectContaining({ reasonCode: "business_email_not_verified" }),
    );
  });

  it("supports an approved pluggable policy clearing an application", async () => {
    const result = await new CompositeGraduationVerifier("approved_policy_v1", [
      signal("business_identity", "clear"),
      signal("risk_screen", "clear"),
    ]).verify(input);
    expect(result.outcome).toBe("clear");
  });

  it("uses the most restrictive signal and rejects duplicate check ids", async () => {
    const verifier = new CompositeGraduationVerifier("approved_policy_v1", [
      signal("identity", "clear"),
      signal("risk", "blocked"),
    ]);
    await expect(verifier.verify(input)).resolves.toMatchObject({ outcome: "blocked" });

    const duplicate = new CompositeGraduationVerifier("bad_policy_v1", [
      signal("same", "clear"),
      signal("same", "manual_review"),
    ]);
    await expect(duplicate.verify(input)).rejects.toThrow("check ids must be unique");
  });
});

function signal(
  id: string,
  outcome: "clear" | "manual_review" | "needs_information" | "blocked",
): GraduationVerificationCheck {
  return {
    id,
    async evaluate() {
      return { checkId: id, outcome, reasonCode: `${id}_${outcome}`, confidence: 1 };
    },
  };
}
